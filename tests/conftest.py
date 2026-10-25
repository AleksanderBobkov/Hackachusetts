import pytest


@pytest.fixture(autouse=True)
def isolated_empty_library(monkeypatch):
    # Most API tests exercise a user's empty store; bundled demo import has its own tests.
    monkeypatch.setenv('COMPANION_SEED_SLIDESHOWS','0')
