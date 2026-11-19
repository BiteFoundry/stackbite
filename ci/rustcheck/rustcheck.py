"""Rust workspace gate for the pinned private StackBite source on a hosted runner.

  pin    print the pinned source commit
  run    install the pinned toolchain, fetch crates, run scripts/qa/gate at level G3
  seal   encrypt the private logs for the recipient certificate

Command output goes to RUNNER_TEMP/private-diagnostics only. Stdout and
RUNNER_TEMP/public-summary carry step names, exit codes, durations and counts.
"""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile, time

HERE = pathlib.Path(__file__).resolve().parent
PIN = json.loads((HERE / 'pin.json').read_text(encoding='utf-8'))
CERT = HERE / 'diagnostics-recipient.pem'
CERT_SHA256 = '3dd53013ff2a4670174a2e7f7a863143db4aa99b6abf3601851d45e903e4827d'
KEEP = 32 << 20   # bytes kept from the end of each private log


def roots():
    temp = pathlib.Path(os.environ['RUNNER_TEMP'])
    return temp / 'private-diagnostics', temp / 'public-summary', temp / 'rc'


def step(steps, name, argv, log, cwd, timeout, env=None):
    started = time.monotonic()
    code = None
    with open(log, 'wb') as out:
        try:
            code = subprocess.run(argv, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, timeout=timeout, env=env).returncode
            status = 'passed' if code == 0 else 'failed'
        except subprocess.TimeoutExpired:
            status = 'timeout'
        except OSError:
            status = 'not_started'
    record = dict(name=name, status=status, exit_code=code, seconds=round(time.monotonic() - started, 1))
    steps.append(record)
    print('step', json.dumps(record), flush=True)
    return status == 'passed'


def user_owned_files():
    """Hosted Windows runners run elevated, so new files are owned by BUILTIN\\Administrators and the
    product's owner-private checks refuse them. Make the user the default owner for this process tree."""
    import ctypes
    from ctypes import wintypes
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                        ctypes.POINTER(wintypes.DWORD)]
    adv.SetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    token = wintypes.HANDLE()
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 0x88, ctypes.byref(token)):   # ADJUST_DEFAULT | QUERY
        return False
    size = wintypes.DWORD()
    adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))                         # TokenUser
    buffer = ctypes.create_string_buffer(size.value)
    if not adv.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
        return False
    owner = ctypes.c_void_p(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0])
    return bool(adv.SetTokenInformation(token, 4, ctypes.byref(owner), ctypes.sizeof(owner)))   # TokenOwner


def flaky_candidates(receipt):
    """Names of the gate's new failures when they are its only failure reason and few enough to rerun."""
    try:
        doc = json.loads(receipt.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return []
    new = doc.get('new_failures') or []
    if doc.get('failure_reasons') != ['new_failures'] or doc.get('new_targets_without_result') or not 1 <= len(new) <= 10:
        return []
    return sorted({test['name'] for test in new})


def only_platform_check_failed(receipt):
    """True when every test step passed and the gate failed only in platform_check.ps1, which needs WSL and a
    cross target that a hosted Windows runner does not have. Linux is tested natively by the other job."""
    try:
        doc = json.loads(receipt.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return False
    steps = {item.get('name'): item.get('status') for item in doc.get('steps') or []}
    return doc.get('failure_reasons') == ['platform_check_error'] and steps.get('tests') == 'pass'


def mode_run():
    private, public, work = roots()
    owner = user_owned_files() if os.name == 'nt' else None
    for d in (private, public, work):
        d.mkdir(mode=0o700)
    source = pathlib.Path(os.environ['GITHUB_WORKSPACE']) / '.ci-private-source'
    rust = source / 'rust'
    windows = os.name == 'nt'
    toolchain = PIN['toolchain']
    env = dict(os.environ, RUSTUP_TOOLCHAIN=toolchain, CARGO_TERM_COLOR='never', CARGO_TARGET_DIR=str(work / 'target'))
    for name in ('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'):
        env.pop(name, None)
    gate_out = private / 'gate'
    if windows:
        gate = ['pwsh', '-NoProfile', '-File', str(source / 'scripts/qa/gate.ps1'), '-Level', 'G3',
                '-AllowPlatformSkip', '-OutDir', str(gate_out)]
    else:
        gate = ['bash', str(source / 'scripts/qa/gate.sh'), '--level', 'G3', '--allow-platform-skip',
                '--out-dir', str(gate_out)]
    # Known failures live on a branch of the private repository, so test names never reach this one.
    known = subprocess.run(['git', '-C', str(source), 'show',
                            'origin/ci/rustcheck-baseline:' + ('windows.json' if windows else 'linux.json')],
                           capture_output=True)
    baseline = None
    if known.returncode == 0:
        baseline = work / 'baseline.json'
        baseline.write_bytes(known.stdout)
        gate += ['-Baseline' if windows else '--baseline', str(baseline)]
    plan = [
        ('toolchain', ['rustup', 'toolchain', 'install', toolchain, '--profile', 'minimal', '--no-self-update'], 900),
        ('fetch', ['cargo', 'fetch', '--locked'], 900),
        ('gate', gate, 6000),
    ]
    steps = []
    ok = True
    for name, argv, timeout in plan:
        if not ok:
            steps.append(dict(name=name, status='not_run', exit_code=None, seconds=0))
            continue
        ok = step(steps, name, argv, private / (name + '.log'), rust, timeout, env)
    # A test that fails once and passes alone right after is reported as retried, not as a pass of the gate step.
    retried = 0
    names = [] if ok or steps[-1]['name'] != 'gate' or steps[-1]['status'] != 'failed' else flaky_candidates(gate_out / 'gate-receipt.json')
    if names:
        wrapper = (['pwsh', '-NoProfile', '-File', str(source / 'scripts/qa/run_tests.ps1')] if windows
                   else ['bash', str(source / 'scripts/qa/run_tests.sh')])
        log = private / 'retry.log'
        again = step(steps, 'retry', wrapper + ['--label', 'retry', '--', 'test', '--locked', '--offline', '--no-fail-fast',
                                                '--workspace', '--', '--exact', *names], log, rust, 3000, env)
        text = log.read_text(encoding='utf-8', errors='replace')
        ok = again and all('test %s ... ok' % name in text for name in names)
        retried = len(names)
    platform_check = None
    if windows and not ok and not names and steps[-1]['name'] == 'gate' and only_platform_check_failed(gate_out / 'gate-receipt.json'):
        ok = True
        platform_check = 'not_available_on_runner'
    summary = dict(schema='stackbite.rustcheck.public-summary.v1', runner_os=os.environ.get('RUNNER_OS'),
                   source_commit=PIN['commit'], toolchain=toolchain, user_owned_files=owner, baseline=baseline is not None,
                   retried_new_failures=retried, platform_check=platform_check, steps=steps, passed=ok,
                   gate=None)
    receipt = gate_out / 'gate-receipt.json'
    if receipt.is_file():
        try:
            doc = json.loads(receipt.read_text(encoding='utf-8-sig'))
            flat = {}
            def numbers(prefix, value):
                if isinstance(value, bool) or value is None:
                    flat[prefix] = value
                elif isinstance(value, (int, float)):
                    flat[prefix] = value
                elif isinstance(value, dict):
                    for key, item in value.items():
                        if str(key).isidentifier():
                            numbers(prefix + '.' + str(key) if prefix else str(key), item)
                elif isinstance(value, list):
                    flat[prefix + '.len'] = len(value)
            numbers('', {k: v for k, v in doc.items() if k not in ('steps', 'commands')})
            summary['gate'] = flat
        except Exception:
            summary['gate'] = 'receipt_unreadable'
    (public / 'public-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print('summary', json.dumps(summary), flush=True)
    shutil.rmtree(work / 'target', ignore_errors=True)
    return 0 if ok else 1


def openssl():
    for candidate in (r'C:\Program Files\Git\usr\bin\openssl.exe', shutil.which('openssl')):
        if candidate and os.path.isfile(candidate):
            version = subprocess.run([candidate, 'version'], capture_output=True, text=True).stdout
            if version.startswith('OpenSSL 3.'):
                return candidate
    return None


def mode_seal():
    private, public, _ = roots()
    public.mkdir(mode=0o700, exist_ok=True)
    if not private.is_dir():
        print('diagnostics=absent')
        return 0
    # A Windows checkout may hand the certificate over with CRLF line ends.
    pem = CERT.read_bytes().replace(b'\r\n', b'\n')
    if hashlib.sha256(pem).hexdigest() != CERT_SHA256:
        print('diagnostics=certificate_refused')
        return 1
    cert = private.parent / 'diagnostics-recipient.pem'
    cert.write_bytes(pem)
    ssl = openssl()
    if not ssl:
        print('diagnostics=openssl_unavailable')
        return 1
    payload = private.parent / 'diagnostics-payload.tar'
    count = 0
    with tarfile.open(payload, 'w', format=tarfile.PAX_FORMAT) as tar:
        for path in sorted(private.rglob('*')):
            if path.is_symlink() or not path.is_file():
                continue
            size = path.stat().st_size
            info = tarfile.TarInfo(('ci-out' / path.relative_to(private)).as_posix())
            with open(path, 'rb') as handle:
                if size > KEEP:
                    handle.seek(size - KEEP)
                    size = KEEP
                info.size = size
                tar.addfile(info, handle)
            count += 1
    if not count:
        print('diagnostics=archive_empty')
        return 1
    cms = public / 'private-diagnostics.cms'
    done = subprocess.run([ssl, 'cms', '-encrypt', '-binary', '-aes-256-gcm', '-outform', 'DER', '-in', str(payload),
                           '-out', str(cms), '-recip', str(cert), '-keyopt', 'rsa_padding_mode:oaep',
                           '-keyopt', 'rsa_oaep_md:sha256'], capture_output=True)
    payload.unlink()
    if done.returncode != 0:
        cms.unlink(missing_ok=True)
        print('diagnostics=encryption_failed')
        return 1
    envelope = dict(format='openssl-cms-authenveloped-der', cipher='AES-256-GCM', recipient='RSA-3072-OAEP-SHA256',
                    recipient_certificate_sha256=CERT_SHA256, ciphertext_sha256=hashlib.sha256(cms.read_bytes()).hexdigest(),
                    ciphertext_bytes=cms.stat().st_size, members=count, plaintext_uploaded=False)
    (public / 'diagnostics-envelope.json').write_text(json.dumps(envelope, indent=2) + '\n', encoding='utf-8')
    print('diagnostics=encrypted')
    return 0


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode == 'pin':
        print(PIN['commit'])
        sys.exit(0)
    try:
        sys.exit({'run': mode_run, 'seal': mode_seal}[mode]())
    except Exception as error:   # the message may quote private paths or output
        print('rustcheck=internal_error', type(error).__name__)
        sys.exit(2)
