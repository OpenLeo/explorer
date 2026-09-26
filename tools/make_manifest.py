#!/usr/bin/env python3
"""
Write a manifest.json at the root of a DBMUXEv repository, so OpenLEO Explorer
can load it from any static HTTP server ("HTTP URL" source).

    python3 tools/make_manifest.py /path/to/PSA-RE [--revision X] [--output FILE]

The manifest lists the relevant files (architectures.yml, nodes/, cars/, buses/, diag/).
Symbolic links are listed in "symlinks" as {link path: target path} (paths relative to
the repository root), so the explorer fetches the target only once and knows both frames
are the same. The revision is the git HEAD commit when available (used as cache key).
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

RELEVANT_DIRS = ('nodes', 'cars', 'buses', 'diag')


def relevant(rel):
    parts = rel.split('/')
    if rel in ('architectures.yml', 'architectures.yaml'):
        return True
    if parts[0] not in RELEVANT_DIRS:
        return False
    if parts[0] == 'buses' and len(parts) == 4 and rel.lower().endswith(('.md', '.txt')):
        return True
    return rel.endswith(('.yml', '.yaml'))


def git_revision(root):
    try:
        out = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            rev = out.stdout.strip()
            dirty = subprocess.run(['git', '-C', root, 'status', '--porcelain'], capture_output=True, text=True, timeout=30)
            if dirty.returncode == 0 and dirty.stdout.strip():
                rev += '-dirty-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
            return rev
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def main():
    ap = argparse.ArgumentParser(description='Generate manifest.json for OpenLEO Explorer')
    ap.add_argument('root', help='repository root (folder containing architectures.yml)')
    ap.add_argument('--output', help='output file (default: <root>/manifest.json)')
    ap.add_argument('--revision', help='revision string used as cache key (default: git HEAD or date)')
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isfile(os.path.join(root, 'architectures.yml')):
        print(f'warning: {root}/architectures.yml not found', file=sys.stderr)

    files = []
    symlinks = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
        # follow symlinked directories as plain directories (their files are listed as links)
        for d in list(dirnames):
            p = os.path.join(dirpath, d)
            if os.path.islink(p):
                dirnames.remove(d)
                rel_dir = os.path.relpath(p, root).replace(os.sep, '/')
                target_dir = os.path.relpath(os.path.realpath(p), root).replace(os.sep, '/')
                for sub, _, fns in os.walk(os.path.realpath(p)):
                    for fn in sorted(fns):
                        t = os.path.relpath(os.path.join(sub, fn), root).replace(os.sep, '/')
                        link = rel_dir + t[len(target_dir):]
                        if relevant(link):
                            symlinks[link] = t
        for fn in sorted(filenames):
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            if not relevant(rel):
                continue
            if os.path.islink(p):
                real = os.path.realpath(p)
                if not os.path.exists(real):
                    print(f'warning: broken symlink {rel}', file=sys.stderr)
                    continue
                target = os.path.relpath(real, root).replace(os.sep, '/')
                if target.startswith('..'):
                    files.append(rel)  # points outside of the repository: serve it as a file
                else:
                    symlinks[rel] = target
            else:
                files.append(rel)

    manifest = {
        'format': 'openleo-explorer-manifest/1',
        'revision': args.revision or git_revision(root) or datetime.datetime.now().strftime('%Y%m%d%H%M%S'),
        'generated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'files': files,
        'symlinks': symlinks,
    }
    out = args.output or os.path.join(root, 'manifest.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    print(f'{out}: {len(files)} files, {len(symlinks)} symlinks, revision {manifest["revision"]}')


if __name__ == '__main__':
    main()
