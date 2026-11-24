"""Read Google Cloud configuration and deliver it to the host over IAP SSH."""
import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path


def gcloud_output(*args):
    return subprocess.check_output(['gcloud', *args], text=True).strip()


def main():
    env = os.environ
    project = f"--project={env['GCP_PROJECT']}"
    payload = {
        'image': env['IMAGE'],
        'revision': env['GITHUB_SHA'],
        'environment': json.loads(gcloud_output(
            'secrets', 'versions', 'access', 'latest',
            '--secret=yuvomi-runtime', project,
        )),
        'registryToken': gcloud_output('auth', 'print-access-token'),
    }
    proxy = shlex.join([
        'gcloud', 'compute', 'start-iap-tunnel', env['GCE_INSTANCE'], '%p',
        project, f"--zone={env['GCE_ZONE']}", '--listen-on-stdin', '--verbosity=warning',
    ])
    with tempfile.TemporaryDirectory(prefix='yuvomi-ssh-') as directory:
        key = Path(directory) / 'identity'
        known_hosts = Path(directory) / 'known_hosts'
        os.umask(0o077)
        key.write_text(gcloud_output(
            'secrets', 'versions', 'access', 'latest', '--secret=yuvomi-deploy-ssh', project,
        ) + '\n', encoding='ascii')
        known_hosts.write_text(env['GCE_KNOWN_HOST'] + '\n', encoding='ascii')
        subprocess.run([
            'ssh', '-T', '-i', str(key), '-oBatchMode=yes', '-oIdentitiesOnly=yes',
            '-oStrictHostKeyChecking=yes', f'-oUserKnownHostsFile={known_hosts}',
            f'-oProxyCommand={proxy}', f"yuvomi-deploy@{env['GCE_INSTANCE']}",
        ], input=json.dumps(payload), text=True, check=True)


if __name__ == '__main__':
    main()
