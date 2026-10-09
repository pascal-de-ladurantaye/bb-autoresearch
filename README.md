# bb-plugin-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes in parallel; the plugin owns the loop, the
measurements, and every keep or discard decision.

Design: [docs/design.md](docs/design.md)

Status: design only, M0 in progress.
