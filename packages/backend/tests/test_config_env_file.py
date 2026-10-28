from pathlib import Path

from moire.core import config


def test_moire_env_file_is_the_only_dotenv(monkeypatch, tmp_path):
    only = tmp_path / "sandbox.env"
    monkeypatch.setenv("MOIRE_ENV_FILE", str(only))
    assert config._env_files() == (only,)


def test_checkout_reads_home_then_backend_dotenv(monkeypatch):
    monkeypatch.delenv("MOIRE_ENV_FILE", raising=False)
    files = config._env_files()
    assert files[0] == config.MOIRE_HOME / ".env"
    if config.IS_CHECKOUT:
        assert files[1] == Path(config._BACKEND_ROOT) / ".env"
