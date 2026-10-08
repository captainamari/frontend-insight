"""CI-only image-layer audit; prints hashes/status, never secret contents."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

assert os.environ.get("GITHUB_ACTIONS") == "true", "CI only"
secrets = [p.read_bytes().strip() for p in Path(".secrets/production").iterdir() if p.is_file()]
assert secrets and all(len(value) >= 32 for value in secrets)
results = []
for image in ["frontend-insight-app:production-ci", "frontend-insight-web:production-ci"]:
    with tempfile.TemporaryDirectory() as temporary:
        archive = str(Path(temporary) / "image.tar")
        subprocess.run(["docker", "image", "save", "--output", archive, image], check=True)
        with tarfile.open(archive) as outer:
            manifest = json.load(outer.extractfile("manifest.json"))
            for layer in manifest[0]["Layers"]:
                with tarfile.open(fileobj=outer.extractfile(layer), mode="r|*") as contents:
                    for member in contents:
                        name = member.name.lstrip("./")
                        assert not any(name == "app/" + d or name.startswith("app/" + d + "/") for d in [".secrets", ".runtime", "backups"]), "EXCLUDED_DIRECTORY_IN_LAYER"
                        if not member.isfile():
                            continue
                        stream = contents.extractfile(member)
                        tail = b""
                        while True:
                            chunk = stream.read(1024 * 1024)
                            if not chunk:
                                break
                            data = tail + chunk
                            assert not any(secret in data for secret in secrets), "SECRET_IN_IMAGE_LAYER"
                            tail = data[-4096:]
        image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
        results.append({"image": image, "imageId": image_id, "allLayersSecretFree": True})
Path("artifacts").mkdir(exist_ok=True)
Path("artifacts/production-images.json").write_text(json.dumps({"testedCommit": os.environ["GITHUB_SHA"], "results": results}, indent=2))
print("All application and web image layers passed secret exclusion checks")
