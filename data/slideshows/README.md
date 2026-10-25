# Bundled standby slideshows

These 20 app-prepared JPEGs came from the user's OneDrive `Hackathon Families` folders.
The source files had generated image filenames and no identifying name labels. The app's
example profiles are assigned by folder order, not verified visual identity:

- Family #1 -> María Elena: 8 photos
- Family #2 -> James: 7 photos
- Family #3 -> Amina: 5 photos

The app creates display copies with the longest side at most 1600 pixels; the originals
remain in OneDrive. `manifest.json` defines the assignment and order. Keep this directory,
its images, and `companion/seed.py` in Git and deployment packages.

On first startup with an empty library, the backend imports these as example people and
photos. It keeps a completion marker in runtime data so later renames/removals survive
restart. Existing nonempty libraries are left alone. Set `COMPANION_SEED_SLIDESHOWS=0` to
disable the initial demo import.
