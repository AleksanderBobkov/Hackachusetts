import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from companion.api.app import app
from companion.api.profiles import ProfileStore
from companion.seed import seed_slideshows


def bundle(tmp_path):
    assets=tmp_path/'assets'
    assets.mkdir()
    (assets/'one.jpg').write_bytes(b'\xff\xd8\xff'+bytes(64))
    (assets/'manifest.json').write_text(json.dumps({'version':'test-v1','profiles':[{'display_name':'Example','photos':[{'file':'one.jpg','name':'Test photo'}]}]}),encoding='utf-8')
    return assets


def test_seed_runs_once_and_respects_photo_removal_and_renaming(tmp_path):
    assets=bundle(tmp_path)
    store=ProfileStore(tmp_path/'runtime')
    seed_slideshows(store,assets)
    profile=store.list()['profiles'][0]
    assert profile['example'] and len(profile['photos'])==1
    store.remove_photo(profile['profile_id'],profile['photos'][0]['photo_id'])
    store.rename(profile['profile_id'],'Renamed')
    store=ProfileStore(store.root)
    seed_slideshows(store,assets)
    assert store.list()['profiles'][0]['display_name']=='Renamed'
    assert store.list()['profiles'][0]['photos']==[]
    assert len(store.list()['profiles'])==1


def test_seed_leaves_an_existing_library_untouched(tmp_path):
    assets=bundle(tmp_path)
    store=ProfileStore(tmp_path/'runtime')
    store.create('My person',None)
    seed_slideshows(store,assets)
    assert [p['display_name'] for p in store.list()['profiles']]==['My person']


def test_partial_import_can_resume_without_duplicate_people_or_photos(tmp_path,monkeypatch):
    assets=bundle(tmp_path)
    store=ProfileStore(tmp_path/'runtime')
    original=store.add_photo
    def fail(*args,**kwargs):raise OSError('simulated interruption')
    monkeypatch.setattr(store,'add_photo',fail)
    with pytest.raises(OSError):seed_slideshows(store,assets)
    monkeypatch.setattr(store,'add_photo',original)
    seed_slideshows(store,assets)
    assert len(store.list()['profiles'])==1
    assert len(store.list()['profiles'][0]['photos'])==1


def test_manifest_cannot_read_outside_its_directory(tmp_path):
    assets=bundle(tmp_path)
    manifest=json.loads((assets/'manifest.json').read_text())
    manifest['profiles'][0]['photos'][0]['file']='../outside.jpg'
    (assets/'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError):seed_slideshows(ProfileStore(tmp_path/'runtime'),assets)


def test_fresh_app_includes_all_twenty_images_and_serves_them(tmp_path,monkeypatch):
    monkeypatch.setenv('COMPANION_DATA_DIR',str(tmp_path/'runtime'))
    monkeypatch.setenv('COMPANION_SEED_SLIDESHOWS','1')
    with TestClient(app) as client:
        profiles=client.get('/profiles').json()['profiles']
        assert {p['display_name']:len(p['photos']) for p in profiles}=={'María Elena':8,'James':7,'Amina':5}
        for profile in profiles:
            for photo in profile['photos']:
                response=client.get(photo['url'])
                assert response.status_code==200
                assert response.headers['content-type']=='image/jpeg'
    with TestClient(app) as client:
        assert sum(len(p['photos']) for p in client.get('/profiles').json()['profiles'])==20
