"""Append-only Parquet time-series store for water quality indices.

Schema: (waterbody_id, zone_id, date, scene_id, ndti, ndci, fai, texture_score, cloud_pct)
Keyed by (waterbody_id, zone_id, date) — one row per zone per scene date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

# Schema definition
SCHEMA = pa.schema([
    ("waterbody_id", pa.string()),
    ("zone_id", pa.string()),
    ("date", pa.date32()),
    ("scene_id", pa.string()),
    ("ndti", pa.float32()),
    ("ndci", pa.float32()),
    ("fai", pa.float32()),
    ("texture_score", pa.float32()),
    ("cloud_pct", pa.float32()),
])

PARTITION_COLS = ["waterbody_id", "zone_id"]  # Partition by waterbody and zone


@dataclass
class Observation:
    """Single zone observation for a given date."""
    waterbody_id: str
    zone_id: str
    date: date
    scene_id: str
    ndti: Optional[float]
    ndci: Optional[float]
    fai: Optional[float]
    texture_score: Optional[float]
    cloud_pct: float


class TimeseriesStore:
    """Parquet-based append-only time series store."""

    def __init__(self, root_dir: str | Path):
        self.root_dir = Path(root_dir)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def _partition_path(self, waterbody_id: str, zone_id: str) -> Path:
        """Get the Parquet file path for a waterbody/zone partition."""
        safe_wb = waterbody_id.replace("/", "_").replace(" ", "_")
        safe_zone = zone_id.replace("/", "_").replace(" ", "_")
        return self.root_dir / f"wb={safe_wb}" / f"zone={safe_zone}.parquet"

    def append(self, observations: list[Observation]) -> None:
        """Append observations to the store, creating partitions as needed."""
        if not observations:
            return

        # Group by partition
        by_partition: dict[tuple[str, str], list[Observation]] = {}
        for obs in observations:
            key = (obs.waterbody_id, obs.zone_id)
            by_partition.setdefault(key, []).append(obs)

        for (wb_id, zone_id), obs_list in by_partition.items():
            path = self._partition_path(wb_id, zone_id)
            path.parent.mkdir(parents=True, exist_ok=True)

            # Convert to DataFrame
            df = pd.DataFrame([{
                "waterbody_id": o.waterbody_id,
                "zone_id": o.zone_id,
                "date": o.date,
                "scene_id": o.scene_id,
                "ndti": o.ndti,
                "ndci": o.ndci,
                "fai": o.fai,
                "texture_score": o.texture_score,
                "cloud_pct": o.cloud_pct,
            } for o in obs_list])

            # Ensure date column is datetime64[ns] for Parquet
            df["date"] = pd.to_datetime(df["date"])

            table = pa.Table.from_pandas(df, schema=SCHEMA)

            if path.exists():
                # Append to existing file
                existing = pq.read_table(path)
                combined = pa.concat_tables([existing, table])
                # Deduplicate by (waterbody_id, zone_id, date, scene_id) - keep latest
                combined_df = combined.to_pandas()
                combined_df = combined_df.drop_duplicates(
                    subset=["waterbody_id", "zone_id", "date", "scene_id"],
                    keep="last"
                )
                combined_df = combined_df.sort_values(["date", "scene_id"])
                final_table = pa.Table.from_pandas(combined_df, schema=SCHEMA)
                pq.write_table(final_table, path)
            else:
                pq.write_table(table, path)

    def query(
        self,
        waterbody_id: str,
        zone_id: Optional[str] = None,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> pd.DataFrame:
        """Query observations for a waterbody (and optionally zone/date range)."""
        if zone_id:
            path = self._partition_path(waterbody_id, zone_id)
            if not path.exists():
                return pd.DataFrame(columns=SCHEMA.names)
            table = pq.read_table(path)
        else:
            # Read all zones for this waterbody
            wb_dir = self.root_dir / f"wb={waterbody_id.replace('/', '_').replace(' ', '_')}"
            if not wb_dir.exists():
                return pd.DataFrame(columns=SCHEMA.names)
            files = list(wb_dir.glob("zone=*.parquet"))
            if not files:
                return pd.DataFrame(columns=SCHEMA.names)
            tables = [pq.read_table(f) for f in files]
            table = pa.concat_tables(tables)

        df = table.to_pandas()

        # Filter by date range
        if start_date:
            df = df[df["date"] >= pd.Timestamp(start_date)]
        if end_date:
            df = df[df["date"] <= pd.Timestamp(end_date)]

        return df.sort_values(["zone_id", "date"]).reset_index(drop=True)

    def get_latest_date(self, waterbody_id: str, zone_id: str) -> Optional[date]:
        """Get the latest date for a specific zone."""
        path = self._partition_path(waterbody_id, zone_id)
        if not path.exists():
            return None
        table = pq.read_table(path, columns=["date"])
        if len(table) == 0:
            return None
        max_date = table.column("date").combine_chunks().max().as_py()
        return max_date

    def get_all_zones(self, waterbody_id: str) -> list[str]:
        """Get all zone IDs for a waterbody."""
        wb_dir = self.root_dir / f"wb={waterbody_id.replace('/', '_').replace(' ', '_')}"
        if not wb_dir.exists():
            return []
        zones = []
        for f in wb_dir.glob("zone=*.parquet"):
            # Extract zone_id from filename: zone=zone_0.parquet
            zone_part = f.stem  # "zone=zone_0"
            zone_id = zone_part.split("=", 1)[1]
            zones.append(zone_id)
        return sorted(zones)

    def get_date_range(self, waterbody_id: str, zone_id: str) -> tuple[Optional[date], Optional[date]]:
        """Get min and max date for a zone."""
        path = self._partition_path(waterbody_id, zone_id)
        if not path.exists():
            return (None, None)
        table = pq.read_table(path, columns=["date"])
        if len(table) == 0:
            return (None, None)
        dates = table.column("date").combine_chunks()
        min_d = dates.min().as_py()
        max_d = dates.max().as_py()
        return (min_d, max_d)


# Baseline store (separate from observations)
BASELINE_SCHEMA = pa.schema([
    ("waterbody_id", pa.string()),
    ("zone_id", pa.string()),
    ("index_name", pa.string()),  # "ndti", "ndci", "fai", "texture_score"
    ("month", pa.int32()),  # 1-12
    ("mean", pa.float32()),
    ("std", pa.float32()),
    ("n_samples", pa.int32()),
])


class BaselineStore:
    """Seasonal baseline store: mean + std per zone, per index, per calendar month."""

    def __init__(self, root_dir: str | Path):
        self.root_dir = Path(root_dir)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def _baseline_path(self, waterbody_id: str) -> Path:
        safe_wb = waterbody_id.replace("/", "_").replace(" ", "_")
        return self.root_dir / f"wb={safe_wb}" / "baselines.parquet"

    def compute_and_save(
        self,
        waterbody_id: str,
        observations_df: pd.DataFrame,
        min_samples_per_month: int = 3,
    ) -> pd.DataFrame:
        """Compute seasonal baselines from observations and save to disk.

        Args:
            waterbody_id: Water body identifier
            observations_df: DataFrame from TimeseriesStore.query()
            min_samples_per_month: Minimum observations needed for a valid baseline

        Returns:
            DataFrame with baseline statistics
        """
        if observations_df.empty:
            return pd.DataFrame(columns=BASELINE_SCHEMA.names)

        df = observations_df.copy()
        df["month"] = df["date"].dt.month

        index_cols = ["ndti", "ndci", "fai", "texture_score"]
        records = []

        for zone_id in df["zone_id"].unique():
            zone_df = df[df["zone_id"] == zone_id]

            for idx_name in index_cols:
                for month in range(1, 13):
                    month_df = zone_df[zone_df["month"] == month]
                    valid = month_df[idx_name].dropna()

                    if len(valid) >= min_samples_per_month:
                        records.append({
                            "waterbody_id": waterbody_id,
                            "zone_id": zone_id,
                            "index_name": idx_name,
                            "month": month,
                            "mean": float(valid.mean()),
                            "std": float(valid.std(ddof=1)) if len(valid) > 1 else 0.0,
                            "n_samples": len(valid),
                        })

        baseline_df = pd.DataFrame(records)

        if not baseline_df.empty:
            path = self._baseline_path(waterbody_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            table = pa.Table.from_pandas(baseline_df, schema=BASELINE_SCHEMA)
            pq.write_table(table, path)

        return baseline_df

    def load(self, waterbody_id: str) -> pd.DataFrame:
        """Load baselines for a waterbody."""
        path = self._baseline_path(waterbody_id)
        if not path.exists():
            return pd.DataFrame(columns=BASELINE_SCHEMA.names)
        return pq.read_table(path).to_pandas()

    def get_baseline(
        self,
        waterbody_id: str,
        zone_id: str,
        index_name: str,
        month: int,
    ) -> Optional[tuple[float, float, int]]:
        """Get (mean, std, n_samples) for a specific zone/index/month."""
        df = self.load(waterbody_id)
        if df.empty:
            return None
        row = df[
            (df["zone_id"] == zone_id) &
            (df["index_name"] == index_name) &
            (df["month"] == month)
        ]
        if row.empty:
            return None
        r = row.iloc[0]
        return (float(r["mean"]), float(r["std"]), int(r["n_samples"]))