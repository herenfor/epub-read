#!/usr/bin/env python3
"""Prepare exact local source/dependency inputs; compile them in the Flatpak SDK."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def run(args, cwd, **kwargs):
    return subprocess.run(args, cwd=cwd, check=True, **kwargs)


def archive_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True,
                        help="Dedicated build directory, outside the Git checkout")
    parser.add_argument("--ref", default="HEAD", help="Committed source to package")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output == repo or repo in output.parents:
        parser.error("Keep generated inputs outside the checkout")
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", args.ref + "^{commit}"], cwd=repo, text=True
    ).strip()
    inputs = output / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    # Keep inputs traceable to their commit. Their digests below are also
    # required: a local path alone does not invalidate Flatpak's module cache.
    archive_names = {name: f"{name}-{commit}.tar.gz" for name in
                     ("source", "node-dependencies", "cargo-vendor")}
    run(["git", "archive", "--format=tar.gz", "--prefix=source/",
         "--output=" + str(inputs / archive_names["source"]), commit], repo)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=output) as temp:
        temp = Path(temp)
        with tarfile.open(inputs / archive_names["source"]) as archive:
            archive.extractall(temp, filter="data")
        source = temp / "source"
        # No lifecycle scripts run on the host. TypeScript/Vite and Rust are
        # compiled in the SDK, from this exact source and these locked inputs.
        run(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts",
             "--store-dir", str(output / "pnpm-store")], source)
        with tarfile.open(inputs / archive_names["node-dependencies"], "w:gz") as archive:
            archive.add(source / "node_modules", arcname="dependencies/node_modules")
        vendor = temp / "cargo-vendor"
        # Cargo's standard source-integrity checks remain enabled. No binary
        # from the host's Cargo target or node_modules is copied into the app.
        with (temp / "vendor-config.txt").open("w") as config:
            run(["cargo", "vendor", "--locked", "--offline", "--manifest-path",
                 str(source / "src-tauri/Cargo.toml"), str(vendor)], source, stdout=config)
        with tarfile.open(inputs / archive_names["cargo-vendor"], "w:gz") as archive:
            archive.add(vendor, arcname="dependencies/cargo-vendor")
        flatpak = source / "packaging/flatpak"
        manifest = json.loads((flatpak / "dev.epubreader.app.json").read_text())
        for entry, name in zip(manifest["modules"][0]["sources"], archive_names):
            entry["path"] = "inputs/" + archive_names[name]
            entry["sha256"] = archive_digest(inputs / archive_names[name])
        (output / "dev.epubreader.app.json").write_text(json.dumps(manifest, indent=2) + "\n")
        shutil.copy2(flatpak / "cargo-config.toml", output / "cargo-config.toml")
        version = json.loads((source / "package.json").read_text())["version"]
    (output / "input-source.json").write_text(json.dumps({
        "sourceKind": "commit", "sourceCommit": commit, "version": version,
        "edition": "core", "platform": "linux", "runtime": "org.gnome.Platform//50",
        "scope": "Local source-built Flatpak; not a Flathub submission",
    }, indent=2) + "\n")
    print("Prepared:", output / "dev.epubreader.app.json")


if __name__ == "__main__":
    main()
