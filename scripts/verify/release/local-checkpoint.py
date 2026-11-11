"""Capture dirty tracked files and untracked source without changing git or databases.

Recovery is manual into a NEW checkout at manifest.head, never over a dirty tree:
apply staged.patch with --index, apply worktree.patch, then extract untracked.zip.
Deleted tracked files are represented by the patches. Ignored runtime databases,
credentials and build output are intentionally NOT a source checkpoint.
"""
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[3]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def main():
    if sys.argv[1] == '--verify':
        verify(pathlib.Path(sys.argv[2]).resolve(), pathlib.Path(sys.argv[3]).resolve())
        return
    destination = pathlib.Path(sys.argv[1]).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    for name, args in {
        "staged.patch": ("diff", "--cached", "--binary", "--full-index"),
        "worktree.patch": ("diff", "--binary", "--full-index"),
        "status.txt": ("status", "--porcelain=v1"),
    }.items():
        (destination / name).write_bytes(git(*args))
    untracked = git("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")
    files = []
    tracked = git("ls-files", "-z").decode().split("\0")
    for name in sorted(set(tracked + untracked) - {""}):
        file = ROOT / name
        files.append({"path": name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None})
    with zipfile.ZipFile(destination / "untracked.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in untracked:
            if name and (ROOT / name).is_file():
                archive.write(ROOT / name, name)
    manifest = {"createdAt": datetime.now(timezone.utc).isoformat(), "root": str(ROOT),
                "head": git("rev-parse", "HEAD").decode().strip(), "files": files,
                "artifacts": {name: hashlib.sha256((destination / name).read_bytes()).hexdigest()
                              for name in ["staged.patch", "worktree.patch", "untracked.zip", "status.txt"]}}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"checkpoint": str(destination), "head": manifest["head"], "sourceFiles": len(files)}))


def verify(checkpoint, destination):
    manifest = json.loads((checkpoint / 'manifest.json').read_text(encoding='utf-8'))
    for name, digest in manifest['artifacts'].items():
        assert hashlib.sha256((checkpoint / name).read_bytes()).hexdigest() == digest, name
    destination.mkdir(parents=True, exist_ok=False)
    archive = git('archive', '--format=tar', manifest['head'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(destination, filter='data')
    # Only the newly created disposable directory is initialized/modified.
    subprocess.check_call(['git', 'init', '--quiet'], cwd=destination)
    subprocess.check_call(['git', '-c', 'core.autocrlf=false', 'add', '-A'], cwd=destination)
    for name, options in [('staged.patch', ['--index']), ('worktree.patch', [])]:
        if (checkpoint / name).stat().st_size:
            subprocess.check_call(['git', 'apply', *options, str(checkpoint / name)], cwd=destination)
    with zipfile.ZipFile(checkpoint / 'untracked.zip') as source:
        for name in source.namelist():
            assert (destination / name).resolve().is_relative_to(destination)
        source.extractall(destination)
    for item in manifest['files']:
        file = destination / item['path']
        actual = hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None
        assert actual == item['sha256'], item['path']
    print(json.dumps({'checkpointRestoreVerified': True, 'files': len(manifest['files']), 'destination': str(destination)}))


if __name__ == "__main__":
    main()
