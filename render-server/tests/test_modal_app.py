"""The deployment's settings that must agree with the gateway's (no Modal account needed)."""

from __future__ import annotations

import pytest

pytest.importorskip("modal")


def test_the_gateway_outlives_the_gpus_it_admits():
    """A session's place is in the gateway's memory, for PLACE_MARGIN longer than its GPU runs."""
    import modal_app

    from fury_render.gateway import PLACE_MARGIN

    assert modal_app.RENDERER["scaledown_window"] == modal_app.IDLE_SECONDS
    assert modal_app.GATEWAY_IDLE_SECONDS >= modal_app.IDLE_SECONDS + PLACE_MARGIN
