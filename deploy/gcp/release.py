"""Replace the running Yuvomi container on Compute Engine after a cold SQLite backup."""
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.request import urlopen


ROOT = Path('/opt/yuvomi')
CONTAINER = 'yuvomi'
HEALTH_URL = 'http://127.0.0.1:3000'


def docker(*args, capture=False, **kwargs):
    return subprocess.run(
        ['docker', *args], check=True, text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL, **kwargs,
    ).stdout


def inspect(name):
    return json.loads(docker('inspect', name, capture=True))[0]


def environment(values):
    if not isinstance(values, dict) or any(
        not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key)
        or not isinstance(value, str) or '\x00' in value
        for key, value in values.items()
    ):
        raise ValueError('The runtime secret must be a JSON object of environment strings')
    if any(not values.get(name) for name in ('SESSION_SECRET', 'DB_PATH')):
        raise ValueError('The runtime secret must contain SESSION_SECRET and DB_PATH')
    return values


def database_path(old, runtime):
    previous = dict(item.split('=', 1) for item in old['Config']['Env'])
    for key in ('DB_PATH', 'DB_KEY', 'SESSION_SECRET'):
        if previous.get(key, '') != runtime.get(key, ''):
            raise ValueError(f'{key} differs from the running container')
    path = PurePosixPath(runtime['DB_PATH'])
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('DB_PATH must be absolute and inside the existing data mount')
    for mount in old['Mounts']:
        target = PurePosixPath(mount['Destination'])
        if target == PurePosixPath('/data') and path.is_relative_to(target):
            database = Path(mount['Source']) / path.relative_to(target)
            if database.is_file():
                return database
    raise ValueError('The current SQLite database could not be found on the data mount')


def wait_for_health(revision=None):
    for _ in range(60):
        try:
            with urlopen(f'{HEALTH_URL}/health', timeout=2) as result:
                if json.load(result).get('status') != 'ok':
                    raise ValueError('Yuvomi health endpoint failed')
            if revision:
                with urlopen(f'{HEALTH_URL}/sw.js', timeout=2) as result:
                    if revision.encode() not in result.read():
                        raise ValueError('The service worker returned a different revision')
            return
        except (OSError, ValueError):
            time.sleep(2)
    raise RuntimeError('Yuvomi health or revision check timed out')


def replacement_options(old, runtime):
    host = old['HostConfig']
    if host['PortBindings'] != {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3000'}]}:
        raise ValueError('Expected a loopback-only mapping from port 3000 to Yuvomi')
    networks = old['NetworkSettings']['Networks']
    if len(networks) != 1 or any(mount['Type'] != 'bind' for mount in old['Mounts']):
        raise ValueError('Expected the existing single Docker network and bind mounts')
    options = [
        '--publish', '127.0.0.1:3000:3000', '--network', next(iter(networks)),
        '--health-cmd', 'node -e "require(\'http\').get(\'http://localhost:3000/health\', r => process.exit(r.statusCode === 200 ? 0 : 1))"',
        '--health-interval', '30s', '--health-timeout', '10s', '--health-start-period', '10s',
    ]
    for mount in old['Mounts']:
        mode = 'rw' if mount['RW'] else 'ro'
        options.extend(['--volume', f"{mount['Source']}:{mount['Destination']}:{mode}"])
    for key in runtime:
        options.extend(['--env', key])
    return options


def deploy(image, revision, payload):
    runtime = environment(payload['environment'])
    old = inspect(CONTAINER)
    database = database_path(old, runtime)
    options = replacement_options(old, runtime)
    registry = image.split('/', 1)[0]
    with tempfile.TemporaryDirectory(prefix='yuvomi-docker-') as config:
        docker('--config', config, 'login', registry, '--username', 'oauth2accesstoken',
               '--password-stdin', input=payload['registryToken'])
        docker('--config', config, 'pull', image)
    expected = f'APP_BUILD_REVISION={revision}'
    if expected not in inspect(image)['Config']['Env'] or 'APP_BUILD_REVISION' in runtime:
        raise ValueError('The image and environment must use the expected build revision')

    backup = Path(tempfile.mkdtemp(prefix='gcp-', dir=ROOT / 'deployment-backups'))
    previous = f'{CONTAINER}-{backup.name}'
    db_files = [database.with_name(database.name + suffix) for suffix in ('', '-wal', '-shm')]
    candidate = f'{previous}-candidate'
    policy = old['HostConfig']['RestartPolicy']['Name'] or 'no'
    candidate_id = docker(
        'create', '--name', candidate, '--restart', 'unless-stopped',
        *options, image, capture=True, env={**os.environ, **runtime},
    ).strip()
    renamed = False
    started = False
    owners = {}
    try:
        docker('stop', '--time', '30', old['Id'])
        for file in db_files:
            if file.exists():
                stat = file.stat()
                owners[file] = (stat.st_uid, stat.st_gid)
                shutil.copy2(file, backup / file.name)
        print(f'Cold SQLite backup saved at {backup}', flush=True)
        docker('update', '--restart', 'no', old['Id'])
        docker('rename', old['Id'], previous)
        renamed = True
        docker('rename', candidate_id, CONTAINER)
        started = True
        docker('start', candidate_id)
        wait_for_health(revision)
    except BaseException:
        docker('rm', '-f', candidate_id)
        if started:
            failed = backup / 'failed'
            failed.mkdir(mode=0o700)
            for file in db_files:
                if file.exists():
                    file.rename(failed / file.name)
                saved = backup / file.name
                if saved.exists():
                    shutil.copy2(saved, file)
                    os.chown(file, *owners[file])
        if renamed:
            docker('rename', old['Id'], CONTAINER)
        docker('update', '--restart', policy, old['Id'])
        docker('start', old['Id'])
        wait_for_health()
        print('Restored the previous Yuvomi container after the failed deployment', flush=True)
        raise
    print(f'Deployed {revision}. Previous container: {previous}', flush=True)


def interrupted(signum, _frame):
    raise InterruptedError(f'Deployment interrupted by signal {signum}')


if __name__ == '__main__':
    os.umask(0o077)
    payload = json.load(sys.stdin)
    image, revision = payload['image'], payload['revision']
    if not re.fullmatch(r'us-east1-docker\.pkg\.dev/self-hosted-yuvomi/yuvomi/yuvomi@sha256:[0-9a-f]{64}', image):
        sys.exit('An immutable Artifact Registry image is required')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        sys.exit('A full Git revision is required')
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    (ROOT / 'deployment-backups').mkdir(mode=0o700, exist_ok=True)
    with (ROOT / '.deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(image, revision, payload)
