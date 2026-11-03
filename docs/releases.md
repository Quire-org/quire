# Releases and updates

A release is a pushed tag. `.github/workflows/release.yml` bundles the app for macOS (Apple silicon
only: ONNX Runtime, under the engine, isn't built for Intel Macs), Windows and Linux and attaches
the bundles to a **draft** GitHub release. Nothing reaches installed copies until that draft is
published.

## Making one

1. Raise `version` in `src-tauri/tauri.conf.json`. Installed copies update only to a higher version.
2. Commit, then tag with the release notes as the tag's message. The notes are what the app shows
   when it offers the update (Settings › Updates):

   ```sh
   git tag -a v0.2.0 -m "Encryption names files in batches: much faster on big libraries."
   git push origin v0.2.0
   ```

3. When the workflow is done, look the draft over and publish it. From then on, a copy that checks
   finds it.

## How the app updates

Beside the bundles the workflow puts `latest.json`: the version, the notes, and for each platform a
download and its signature. The app reads it from the repository's latest release (the build knows
its repository from GitHub Actions; a build made elsewhere doesn't update itself, and neither does a
dev build). It goes online only when Check now is pressed, or as it opens when that is turned on.

A download is a job in Activity. The new version goes in place with a restart, which waits until
nothing is running. Before anything is replaced, its signature is checked against the update key in
`tauri.conf.json`, together with the version it was signed for, so an older release can't be passed
off as a newer one.

The macOS app updates from its `.app.tar.gz`, Windows from the NSIS installer, Linux from the
AppImage. A `.deb` install is updated by installing the new `.deb`.

Plugins update from their own repositories (see `docs/plugins.md`). Settings › Updates checks them
with the app and updates together those whose new version asks for nothing new.

## Secrets (once)

Without these the workflow still makes bundles, unsigned and without `latest.json`.

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The update key's private half, as `npx tauri signer generate` writes it |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |
| `MACOS_CERTIFICATE` | A code-signing certificate and its key, as a `.p12`, in base64 |
| `MACOS_CERTIFICATE_PASSWORD` | The `.p12`'s password |

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < updater.key
base64 -i codesign.p12 | gh secret set MACOS_CERTIFICATE
```

**Keep a copy of both somewhere safe.** Without the update key, installed copies can't take a new
release: each would need downloading again by hand, once. A new update key also means a new public
key in `tauri.conf.json`.

**The macOS certificate is self-signed.** macOS knows an app by the certificate that signed it, so
each version signed with the same one is the same app to it: quick unlock's Keychain item and the
permission to read external drives carry over to the update. A new certificate makes macOS ask
once more. It doesn't make the app trusted by macOS: the first launch of a download still needs
right-click › Open (and on Windows, SmartScreen's More info › Run anyway). Making one:

```sh
cat > cs.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = cs
[dn]
CN = Quire
[cs]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout key.pem -out cert.pem -config cs.cnf
openssl pkcs12 -export -inkey key.pem -in cert.pem -out codesign.p12 -name "Quire"
rm key.pem
```

macOS's own `openssl` seals the `.p12` the older way, which macOS's `security` reads; OpenSSL 3
seals it a newer way it can't. The release seals the certificate the older way again before using
it, so either works.

The macOS build runs without the hardened runtime: that is for Apple's notarization, which a
self-signed certificate can't have, and with it macOS would refuse the PDF library the app loads.

## Apple silicon

The Apple silicon build turns on the cipher's vector code (`--cfg chacha20_force_neon`), which
encrypts faster. Before bundling, it runs the cipher's test, which checks the output is byte for
byte what every earlier build wrote: a vault made by one build must open in the next.
