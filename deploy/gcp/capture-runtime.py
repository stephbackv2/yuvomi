"""Stream the live application's configuration into the first Secret Manager version."""
import json
import subprocess
import sys


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]


def env_map(inspected):
    return dict(row.split('=', 1) for row in inspected['Config']['Env'])


live = inspect('yuvomi')
image_env = env_map(inspect(live['Image']))
runtime = {
    key: value for key, value in env_map(live).items()
    if key != 'APP_BUILD_REVISION' and (
        key in ('SESSION_SECRET', 'DB_PATH', 'DB_KEY') or value != image_env.get(key)
    )
}
if not all(runtime.get(key) for key in ('SESSION_SECRET', 'DB_PATH')):
    sys.exit('The running container did not supply SESSION_SECRET and DB_PATH')
json.dump(runtime, sys.stdout, ensure_ascii=True)
