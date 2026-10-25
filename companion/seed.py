"""Install the bundled demo slideshows once, only into a new/empty library."""
from __future__ import annotations

import json
from pathlib import Path

from companion.api.profiles import ProfileStore, _write_durable


def seed_slideshows(store: ProfileStore, assets: Path) -> None:
    manifest_path=assets/'manifest.json'
    if not manifest_path.is_file():
        return
    marker=store.root/'bundled-slideshows.json'
    progress=json.loads(marker.read_text(encoding='utf-8')) if marker.is_file() else None
    if progress and progress.get('complete'):
        return  # Respect later renames and removals, including removal of a bundled photo.
    if not progress and store.list()['profiles']:
        return  # Existing libraries belong to their users; never add sample families to them.
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    version=manifest['version']
    if progress and progress.get('version')!=version:
        raise ValueError('An incomplete slideshow import belongs to a different bundle version')
    # Validate every source before creating people. Paths must remain within the bundle.
    prepared=[]
    for profile in manifest['profiles']:
        photos=[]
        for photo in profile['photos']:
            source=(assets/photo['file']).resolve()
            if not source.is_relative_to(assets.resolve()):
                raise ValueError('Slideshow image path is outside the asset directory')
            photos.append((photo,source.read_bytes()))
        prepared.append((profile,photos))
    _write_durable(marker,json.dumps({'version':version,'complete':False}).encode('utf-8'))
    for index,(profile,photos) in enumerate(prepared):
        person=store.create(profile['display_name'],f'example-person-{index}',example=True)
        for photo,data in photos:
            store.add_photo(person['profile_id'],data,photo['name'],f"bundle:{version}:{photo['file']}")
    _write_durable(marker,json.dumps({'version':version,'complete':True}).encode('utf-8'))
