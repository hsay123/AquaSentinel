"""Alert object construction and evidence image generation."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path
from typing import Optional
import uuid

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend
import matplotlib.pyplot as plt
import numpy as np

from backend.pipeline.anomaly import AnomalyFlag
from backend.pipeline.timeseries_store import TimeseriesStore
from backend.pipeline.explain import generate_explanation


@dataclass
class Alert:
    """Alert object per architecture.md §3 schema."""
    id: str
    waterbody_id: str
    zone_id: str
    zone_polygon: dict  # GeoJSON
    date: str  # ISO date string
    scene_id: str
    indicators: list[dict]  # [{name, value, baseline_mean, baseline_std, z_score}]
    severity: float
    confidence: str  # "high" | "needs_review"
    explanation: str
    evidence: dict  # {before_scene_id, after_scene_id, index_map_png_path, chart_png_path}

    def to_dict(self) -> dict:
        return asdict(self)


def build_alert(
    flag: AnomalyFlag,
    zone_polygon: dict,
    indicators_detail: list[dict],
    evidence_paths: dict,
) -> Alert:
    """Construct an Alert object from an AnomalyFlag and supporting data."""
    explanation = generate_explanation(flag, indicators_detail)

    return Alert(
        id=str(uuid.uuid4())[:8],
        waterbody_id=flag.waterbody_id,
        zone_id=flag.zone_id,
        zone_polygon=zone_polygon,
        date=flag.date.isoformat(),
        scene_id=flag.scene_id,
        indicators=indicators_detail,
        severity=round(flag.severity, 3),
        confidence=flag.confidence,
        explanation=explanation,
        evidence=evidence_paths,
    )


def generate_index_heatmap(
    index_array: np.ndarray,
    zone_polygon: dict,
    index_name: str,
    date_str: str,
    output_path: Path,
    vmin: Optional[float] = None,
    vmax: Optional[float] = None,
) -> None:
    """Generate a heatmap PNG for an index array within a zone.

    Args:
        index_array: 2D numpy array of index values (NaN for non-water)
        zone_polygon: GeoJSON polygon of the zone
        index_name: Name of the index (for title)
        date_str: Date string for title
        output_path: Path to save PNG
        vmin, vmax: Color scale limits (optional)
    """
    fig, ax = plt.subplots(figsize=(6, 6), dpi=150)

    # Mask NaN for display
    masked = np.ma.masked_invalid(index_array)

    if vmin is None:
        vmin = np.nanpercentile(masked, 2)
    if vmax is None:
        vmax = np.nanpercentile(masked, 98)

    im = ax.imshow(masked, cmap="RdYlBu_r", vmin=vmin, vmax=vmax, origin="upper")
    ax.set_title(f"{index_name.upper()} — {date_str}", fontsize=12)
    ax.axis("off")

    # Colorbar
    cbar = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label(index_name.upper(), rotation=270, labelpad=12)

    plt.tight_layout()
    fig.savefig(output_path, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)


def generate_timeseries_chart(
    history_df: pd.DataFrame,
    zone_id: str,
    index_name: str,
    flag_date: date,
    flag_value: float,
    baseline_mean: Optional[float],
    baseline_std: Optional[float],
    output_path: Path,
) -> None:
    """Generate a time-series chart with baseline band for a zone/index.

    Shows the full history, shaded baseline band (mean ± 2σ), and highlights
    the flagged point.
    """
    fig, ax = plt.subplots(figsize=(10, 4), dpi=150)

    zone_df = history_df[history_df["zone_id"] == zone_id].sort_values("date")

    if zone_df.empty:
        ax.text(0.5, 0.5, "No historical data", ha="center", va="center", transform=ax.transAxes)
        fig.savefig(output_path, bbox_inches="tight")
        plt.close(fig)
        return

    dates = zone_df["date"]
    values = zone_df[index_name]

    # Plot all points
    ax.plot(dates, values, "o-", color="#666", alpha=0.5, markersize=3, label="Observations")

    # Plot baseline band if available
    if baseline_mean is not None and baseline_std is not None:
        upper = baseline_mean + 2 * baseline_std
        lower = baseline_mean - 2 * baseline_std
        ax.axhspan(lower, upper, alpha=0.2, color="#2E7D32", label="Baseline ±2σ")
        ax.axhline(baseline_mean, color="#2E7D32", linestyle="--", alpha=0.7, label="Baseline mean")

    # Highlight flagged point
    ax.plot(flag_date, flag_value, "o", color="#C62828", markersize=10, zorder=5, label=f"Flagged ({flag_date})")

    ax.set_title(f"{index_name.upper()} Time Series — Zone {zone_id}", fontsize=12)
    ax.set_ylabel(index_name.upper())
    ax.legend(fontsize=9, loc="upper left")
    ax.grid(True, alpha=0.3)

    # Rotate date labels
    fig.autofmt_xdate(rotation=45)

    plt.tight_layout()
    fig.savefig(output_path, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)


def _nearest_prior_date(history, flag_date):
    """The most recent real observation strictly before the flagged date.

    Used as the "before" side of the evidence pair, so the comparison is two
    genuine acquisitions rather than an arbitrary date.
    """
    if history is None or history.empty:
        return None
    import pandas as pd

    dates = pd.to_datetime(history["date"])
    prior = dates[dates < pd.Timestamp(flag_date)]
    if prior.empty:
        return None
    return prior.max().date()


def generate_evidence_for_alert(
    flag: AnomalyFlag,
    zone_polygon: dict,
    timeseries_store: TimeseriesStore,
    baseline_store,
    evidence_dir: Path,
    aoi_geojson: Optional[dict] = None,
    render_imagery: bool = True,
) -> dict:
    """Generate evidence images for an alert and return their paths.

    ``render_imagery=False`` produces the cheap local artefacts (the time-series
    chart) and the real before/after DATES, but skips the Earth Engine renders.

    This exists because ``GET /alerts`` fans out over every zone: with imagery
    rendering inline, a water body with ~70 flagged zones issued ~200 Earth
    Engine calls per request and the feed took minutes. Imagery is now rendered
    on demand via ``GET /alerts/evidence``; the feed carries dates and the chart
    only.

    If Earth Engine cannot produce the imagery (offline, no valid pixels) the
    paths are ``None`` and ``render_error`` explains why, so the UI shows
    "unavailable" instead of a blank or fake image.
    """
    evidence_dir = Path(evidence_dir)  # callers pass a str; this code needs .mkdir()
    evidence_dir.mkdir(parents=True, exist_ok=True)

    history = timeseries_store.query(flag.waterbody_id, flag.zone_id)
    before_date = _nearest_prior_date(history, flag.date)
    after_date = flag.date

    index_map_path: Optional[str] = None
    before_truecolor: Optional[str] = None
    after_truecolor: Optional[str] = None
    render_error: Optional[str] = None

    if render_imagery and aoi_geojson is None:
        render_error = "No AOI geometry available for this water body."
    elif render_imagery:
        from backend.pipeline.render import render_index_map, render_true_color

        primary_idx_render = flag.statistical_indices[0] if flag.statistical_indices else "ndci"
        try:
            index_meta = render_index_map(
                aoi_geojson,
                flag.waterbody_id,
                primary_idx_render,
                after_date.isoformat() if hasattr(after_date, "isoformat") else str(after_date),
                evidence_dir,
            )
            index_map_path = index_meta["path"]
        except Exception as exc:
            render_error = f"Index map unavailable: {exc}"

        for target, when in (("after", after_date), ("before", before_date)):
            if when is None:
                continue
            try:
                tc = render_true_color(
                    aoi_geojson,
                    flag.waterbody_id,
                    when.isoformat() if hasattr(when, "isoformat") else str(when),
                    evidence_dir,
                )
                if target == "after":
                    after_truecolor = tc["path"]
                else:
                    before_truecolor = tc["path"]
            except Exception as exc:
                render_error = (render_error or "") + f" True-colour {target} unavailable: {exc}"

    # Time-series chart with the real baseline band and the real z-score.
    # Also skipped in feed mode: 74 matplotlib renders dominated the feed's
    # 86s response time. The on-demand evidence endpoint draws it.
    primary_idx = flag.statistical_indices[0] if flag.statistical_indices else "ndci"
    chart_path = evidence_dir / f"{flag.waterbody_id}_{flag.zone_id}_{flag.date}_chart.png"
    chart_value: Optional[str] = None

    if render_imagery:
        baseline = None
        if hasattr(baseline_store, "get_baseline"):
            baseline = baseline_store.get_baseline(
                flag.waterbody_id, flag.zone_id, primary_idx, flag.date.month
            )
        generate_timeseries_chart(
            history, flag.zone_id, primary_idx, flag.date,
            getattr(flag, f"{primary_idx}_z", 0) or 0,
            baseline[0] if baseline else None,
            baseline[1] if baseline else None,
            chart_path,
        )
        chart_value = str(chart_path)

    return {
        "before_scene_id": before_date.isoformat() if before_date else "",
        "after_scene_id": flag.scene_id,
        "before_date": before_date.isoformat() if before_date else None,
        "after_date": after_date.isoformat() if hasattr(after_date, "isoformat") else str(after_date),
        "index_map_png_path": index_map_path,
        "before_truecolor_png_path": before_truecolor,
        "after_truecolor_png_path": after_truecolor,
        "render_error": render_error.strip() if render_error else None,
        "chart_png_path": chart_value,
    }