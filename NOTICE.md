# Notices

Mallkit
Copyright 2026 Mallkit contributors

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

## Third-party dependencies

The admin backend depends on the following packages. Their licences apply to
their own code, not to Mallkit.

| Package | Licence | Note |
|---|---|---|
| express | MIT | |
| @cloudbase/node-sdk | Apache-2.0 | |
| cos-nodejs-sdk-v5 | MIT | |
| multer | MIT | |
| archiver | MIT | |
| sharp | Apache-2.0 | Bundles libvips, which is **LGPL-3.0**. See below. |

### sharp and libvips

Image processing uses [sharp](https://sharp.pixelplumbing.com/), which is
Apache-2.0 but ships prebuilt binaries of
[libvips](https://www.libvips.org/), licensed under **LGPL-3.0**.

Using sharp as an ordinary dependency, as Mallkit does, is dynamic linking and
does not impose LGPL obligations on your own code. If you statically link a
modified libvips into a distributed binary, LGPL-3.0 terms apply to that
binary. For a normal deployment this is not a concern.

### Mini program

The mini program uses the WeChat WeUI extended library and the official
logistics trace plugin, both provided by Tencent under their own terms.
