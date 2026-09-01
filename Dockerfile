# The agents' shared workspace container. Extends Cloudflare's sandbox runtime
# image (Ubuntu + Python 3.11 + Node 24 + git). Keep the tag in lockstep with
# the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.9-python
