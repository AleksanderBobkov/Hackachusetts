"""Run the real kiosk readiness script with curl/sleep replaced by deterministic stubs."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT=Path(__file__).resolve().parents[1]
SHELL=shutil.which('sh') or shutil.which('bash')
if not SHELL and os.name=='nt':
    candidate=Path('C:/Program Files/Git/bin/bash.exe')
    if candidate.is_file():
        SHELL=str(candidate)


@pytest.mark.skipif(not SHELL,reason='A POSIX shell is needed for the actual readiness script')
@pytest.mark.parametrize('ready,expected',[(False,1),(True,0)])
def test_readiness_failure_is_not_reported_as_success(tmp_path,ready,expected):
    # Source functions override external commands while executing the unchanged script.
    script=ROOT/'deploy/pi/wait-for-backend.sh'
    code='curl() { return '+('0' if ready else '1')+'; }; sleep() { :; }; . "$1"'
    env={**os.environ,'COMPANION_WAIT_ATTEMPTS':'2'}
    result=subprocess.run([SHELL,'-c',code,'test',script.as_posix()],env=env,capture_output=True,timeout=10)
    assert result.returncode==expected,result.stderr.decode(errors='replace')


@pytest.mark.skipif(not SHELL,reason='A POSIX shell is needed for syntax validation')
def test_deployment_scripts_have_valid_shell_syntax():
    for script in (ROOT/'deploy/pi').glob('*.sh'):
        result=subprocess.run([SHELL,'-n',script.as_posix()],capture_output=True,timeout=10)
        assert result.returncode==0,result.stderr.decode(errors='replace')
