"""Retired raw-scene server CLI; this is not the configuration-only P04 service."""


def main():
    raise SystemExit(
        "LEGACY_RENDER_DISABLED: raw-scene server startup is retired. "
        "Use the private P04 diagnostic service; paid execution remains disabled."
    )


if __name__ == "__main__":
    main()
