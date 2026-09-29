#!/usr/bin/env python3
"""Generate the 4 explanatory figures for SevillaConference/figures/.

1. norm_compliance.png -- every code limit (the same 15 shown by the
   shape_parameters map) vs. % of buildings failing it, per pilot region
   plus the 3-region total. "Failing" = worst grade only, matching the
   interactive maps' own NORM_INFO convention (see main.js in
   maps/shape_parameters/) -- NOT "grade A only".
2. position_scenarios.png -- the 5 idealised block-position scenarios
   (isolated/lateral/corner/confined/torque) with contact-force arrows,
   taken from footprint_attributes' own docs generator.
3. direction_bbox_vs_inertia.png -- bounding-box vs. principal-axes-of-
   inertia, both methods drawn on the same 4 hand-built test shapes.
4. basic_lengths_idealized.png -- L1/L2/a1/a2/b/c measured and drawn on
   the same 4 idealised test shapes (bbox axis convention).

Run with the footprint_attributes package's own venv:
  code/footprint_attributes/.venv/bin/python SevillaConference/figures/make_figures.py
"""
import io
import math
import sys

sys.path.insert(0, "/home/miguel/Documents/Proyectos/SismicaUPM/code/footprint_attributes/src")

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from PIL import Image

from footprint_attributes import config, direction, position, shape
from footprint_attributes.geometry import min_bounding_box
from footprint_attributes.notebook_utils import (
    basic_length_axis,
    dimension_legend_handles,
    direction_arrow_gdfs,
    load_city,
    plot_dimension_arrows,
)
from footprint_attributes.position import contact_force_vectors
from footprint_attributes.testing_shapes import (
    asymmetric_l_shape_polygon,
    confined_quartet_gdf,
    corner_triplet_gdf,
    gdf_of,
    isolated_building_gdf,
    l_shape_polygon,
    lateral_pair_gdf,
    t_shape_polygon,
    torque_triplet_gdf,
    x_shape_polygon,
)
from footprint_attributes.viz import arrow_gdf

FIGURES = __import__("pathlib").Path(__file__).resolve().parent
DATA_ROOT = "/home/miguel/Documents/Proyectos/SismicaUPM/Data/Datasets"
DATASETS = {
    "mata_redonda": ("san_jose_pilot_region.gpkg", "Mata Redonda"),
    "quisquella": ("santo_domingo_pilot_region.gpkg", "Quisquella"),
    "zona_1": ("guatemala_pilot_region.gpkg", "Zona 1"),
}
CITY_COLORS = {
    "mata_redonda": "#dd6b20",
    "quisquella": "#2f855a",
    "zona_1": "#2b6cb0",
    "total": "#1a202c",
}

INK = "#1a202c"
FILL = "#e2e8f0"
BBOX = "#dd6b20"

plt.rcParams.update(
    {
        "figure.dpi": 110,
        "savefig.dpi": 150,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.15,
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.titleweight": "bold",
        "axes.edgecolor": "#a0aec0",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "legend.frameon": False,
    }
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Norm compliance -- every code limit vs. % of buildings failing it
# ─────────────────────────────────────────────────────────────────────────────

# The 15 (name, family) pairs shown by the shape_parameters map, in the same
# family-interleaved order as SHAPE_ATTRIBUTES in main.js.
PARAMS = [
    ("slenderness_bbox", None),
    ("slenderness_inertia", None),
    ("GNDTII_beta1_mainShapeSlenderness", "GNDTII_beta1_mainShapeSlenderness"),
    ("GNDTII_beta2_setbackRatio", "GNDTII_beta2_setbackRatio"),
    ("GNDTII_beta4_eccentricityRatio", "GNDTII_beta4_eccentricityRatio"),
    ("GNDTII_beta6_setbackSlenderness", "GNDTII_beta6_setbackSlenderness"),
    ("ASCE7_setbackRatio", "ASCE7_setbackRatio"),
    ("ASCE7_holeRatio", "ASCE7_holeRatio"),
    ("ASCE7_parallelityAngle", "ASCE7_parallelityAngle"),
    ("EC8_eccentricityRatio", "EC8_eccentricityRatio"),
    ("EC8_radiusRatio", "EC8_radiusRatio"),
    ("EC8_compactness", "EC8_compactness"),
    ("NTC23_setbackRatio", "NTC23_setbackRatio"),
    ("NTC23_holeRatio", "NTC23_holeRatio"),
    ("CSCR2010_eccentricityRatio", "CSCR2010_eccentricityRatio"),
]
PARAM_LABELS = {
    "slenderness_bbox": "Slenderness (bbox)",
    "slenderness_inertia": "Slenderness (inertia)",
    "GNDTII_beta1_mainShapeSlenderness": "GNDT-II β1 (slenderness)",
    "GNDTII_beta2_setbackRatio": "GNDT-II β2 (setback ratio)",
    "GNDTII_beta4_eccentricityRatio": "GNDT-II β4 (eccentricity ratio)",
    "GNDTII_beta6_setbackSlenderness": "GNDT-II β6 (setback slenderness)",
    "ASCE7_setbackRatio": "ASCE 7 setback ratio",
    "ASCE7_holeRatio": "ASCE 7 hole ratio",
    "ASCE7_parallelityAngle": "ASCE 7 parallelity angle",
    "EC8_eccentricityRatio": "EC8 eccentricity ratio",
    "EC8_radiusRatio": "EC8 radius ratio",
    "EC8_compactness": "EC8 compactness",
    "NTC23_setbackRatio": "NTC-23 setback ratio",
    "NTC23_holeRatio": "NTC-23 hole ratio",
    "CSCR2010_eccentricityRatio": "CSCR-2010 eccentricity ratio",
}


def failure_boundary(column: str) -> tuple[float, bool]:
    """The value beyond which *column* hits its worst (score=0) grade, and
    whether higher values are worse -- "compliant" here means "not the
    worst grade", matching the interactive maps' own NORM_INFO convention
    (see maps/shape_parameters/main.js), not "grade A only".
    """
    if column.startswith("slenderness"):
        grades = config.SLENDERNESS_LIMITS["EC8"]
    else:
        norm, param = column.split("_", 1)
        grades = getattr(config, f"{norm}_LIMITS")[param]
    if grades[-1]["score"] == 0:
        boundary = grades[-2]["max"] if len(grades) > 1 else grades[-1]["max"]
        return boundary, True
    return grades[0]["max"], False


def is_failing(values: pd.Series, column: str) -> pd.Series:
    boundary, worse_high = failure_boundary(column)
    bad = values > boundary if worse_high else values < boundary
    return bad.where(values.notna())


def fig_norm_compliance() -> None:
    all_cols = [c for c, _ in PARAMS if c not in ("slenderness_bbox", "slenderness_inertia")]
    shares: dict[str, dict[str, float]] = {}
    frames = []
    for city, (fname, _) in DATASETS.items():
        gdf = load_city(f"{DATA_ROOT}/{fname}")
        res = shape(gdf, columns=all_cols + ["slenderness_bbox", "slenderness_inertia"])
        frames.append(pd.DataFrame(res.drop(columns="geometry")))
        shares[city] = {
            col: 100 * is_failing(res[col], col).mean() for col, _ in PARAMS
        }
    combined = pd.concat(frames, ignore_index=True)
    shares["total"] = {col: 100 * is_failing(combined[col], col).mean() for col, _ in PARAMS}

    labels = [PARAM_LABELS[c] for c, _ in PARAMS]
    n = len(PARAMS)
    y = np.arange(n)
    order = ["mata_redonda", "quisquella", "zona_1", "total"]
    bar_h = 0.19

    fig, ax = plt.subplots(figsize=(9, 0.5 * n + 1.5))
    for i, key in enumerate(order):
        offs = (i - (len(order) - 1) / 2) * bar_h
        vals = [shares[key][c] for c, _ in PARAMS]
        label = DATASETS[key][1] if key != "total" else "All 3 regions"
        ax.barh(y + offs, vals, height=bar_h, color=CITY_COLORS[key], label=label)
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.set_xlabel("% of buildings failing the code limit")
    ax.set_xlim(0, 100)
    ax.axvline(50, color="#cbd5e0", lw=0.8, zorder=0)
    ax.legend(loc="lower right", ncol=4, bbox_to_anchor=(1.0, -0.11))
    ax.set_title("Norm compliance")
    fig.tight_layout()
    save(fig, FIGURES / "norm_compliance.jpg")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Idealised block-position scenarios
# ─────────────────────────────────────────────────────────────────────────────

_POSITION_COLORS = {
    "isolated": "#4299e1",
    "lateral": "#e2a33f",
    "corner": "#4fbf8f",
    "confined": "#8744ad",
    "torque": "#c0392b",
}


def fig_position_scenarios() -> None:
    scenarios = {
        "isolated": isolated_building_gdf(),
        "lateral": lateral_pair_gdf(),
        "corner": corner_triplet_gdf(),
        "confined": confined_quartet_gdf(),
        "torque": torque_triplet_gdf(),
    }
    fig, axes = plt.subplots(1, 5, figsize=(16, 4.2))
    for ax, (name, gdf) in zip(axes, scenarios.items()):
        gdf = gdf.reset_index(drop=True)
        res = position(gdf)
        cls = res["blockPosition"].iloc[0]
        gdf.iloc[1:].plot(ax=ax, facecolor=FILL, edgecolor="#a0aec0", lw=1)
        gdf.iloc[[0]].plot(
            ax=ax, facecolor=_POSITION_COLORS[cls], edgecolor=INK, lw=1.3, alpha=0.85
        )
        edges, resultants = contact_force_vectors(gdf)
        scale = 0.35 * math.sqrt(gdf.geometry.iloc[0].area)
        e0 = edges[edges["geom_id"] == 0]
        r0 = resultants[resultants["geom_id"] == 0]
        vmax = max([np.linalg.norm(v) for v in e0["vector"]] + [1e-9])
        # contact_force_vectors' raw vectors point FROM the subject building
        # TOWARD the neighbour pressing on it -- flip 180 deg (negative
        # scale) so the arrow reads as "the push this building receives",
        # matching SevillaConference/data/prepare_data.py's own fix.
        if len(e0):
            arrow_gdf(
                np.stack(e0["anchor"]),
                -np.stack(e0["vector"]) / vmax * scale,
                gdf.crs,
                centered=False,
                head_frac=0.3,
            ).plot(ax=ax, color="#4a5568", lw=1.2)
        if len(r0) and np.linalg.norm(r0["vector"].iloc[0]) > 1e-6:
            arrow_gdf(
                np.stack(r0["anchor"]),
                -np.stack(r0["vector"]) / vmax * scale,
                gdf.crs,
                centered=False,
                head_frac=0.3,
            ).plot(ax=ax, color=INK, lw=2.4)
        ax.set_aspect("equal")
        ax.set_axis_off()
        r = res.iloc[0]
        ax.set_title(name, color=_POSITION_COLORS[cls], fontsize=11)
        ax.text(
            0.5,
            -0.04,
            f"force {r['contact_force']:.2f} · confinement {r['contact_confinementRatio']:.2f}\n"
            f"angular acc. {r['contact_angularAcc']:.2f}",
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=8.5,
            color="#4a5568",
        )
    fig.legend(
        handles=[
            Line2D([0], [0], color="#4a5568", lw=1.2, label="unit pressure on each shared wall"),
            Line2D([0], [0], color=INK, lw=2.4, label="resultant contact force"),
            Patch(facecolor=FILL, edgecolor="#a0aec0", label="neighbours"),
        ],
        loc="lower center",
        ncol=3,
        bbox_to_anchor=(0.5, -0.08),
    )
    save(fig, FIGURES / "position_scenarios.jpg")


# ─────────────────────────────────────────────────────────────────────────────
# 3. bbox vs. inertia axes on the hand-built test shapes
# ─────────────────────────────────────────────────────────────────────────────


def fig_direction_methods() -> None:
    shapes = {
        "L-shape": l_shape_polygon(),
        "T-shape": t_shape_polygon(),
        "X-shape": x_shape_polygon(),
        "asymmetric L": asymmetric_l_shape_polygon(),
    }
    fig, axes = plt.subplots(1, 4, figsize=(14, 4))
    for ax, (name, poly) in zip(axes, shapes.items()):
        g = gdf_of(poly)
        g.plot(ax=ax, facecolor=FILL, edgecolor=INK, linewidth=1.2, zorder=2)
        ax.set_aspect("equal")
        ax.set_axis_off()
        gpd.GeoSeries([poly.minimum_rotated_rectangle]).plot(
            ax=ax, facecolor="none", edgecolor=BBOX, lw=1.2, zorder=3
        )
        L1, d1, L2, d2, bb = direction.bbox(g, mode="all")
        for kind, arr in direction_arrow_gdfs(g, d1, L1, d2, L2).items():
            arr.plot(ax=ax, color=BBOX, lw=1.6, zorder=4)
        Li1, di1, Li2, di2, bi = direction.inertia(g, mode="all")
        for kind, arr in direction_arrow_gdfs(g, di1, Li1, di2, Li2).items():
            arr.plot(ax=ax, color=INK, lw=1.4, ls="--", zorder=5)
        ax.set_title(f"{name}\nbearing: bbox {bb[0]:.0f}° · inertia {bi[0]:.0f}°", fontsize=10)
    fig.legend(
        handles=[
            Patch(facecolor="none", edgecolor=BBOX, label="minimum bounding box"),
            Line2D([0], [0], color=BBOX, lw=1.6, label="bbox axes (L1, L2)"),
            Line2D([0], [0], color=INK, lw=1.4, ls="--", label="inertia axes (L1, L2)"),
        ],
        loc="lower center",
        ncol=3,
        bbox_to_anchor=(0.5, -0.06),
    )
    fig.suptitle("Direction: minimum bounding box vs. principal axes of inertia", y=1.02)
    save(fig, FIGURES / "direction_bbox_vs_inertia.jpg")


# ─────────────────────────────────────────────────────────────────────────────
# 4. L1/L2/a1/a2/b/c measured on the idealised test shapes
# ─────────────────────────────────────────────────────────────────────────────


def fig_basic_lengths() -> None:
    shapes = {
        "L-shape": gdf_of(l_shape_polygon()),
        "T-shape": gdf_of(t_shape_polygon()),
        "X-shape": gdf_of(x_shape_polygon()),
        "asymmetric L": gdf_of(asymmetric_l_shape_polygon()),
    }
    fig, axes = plt.subplots(1, len(shapes), figsize=(4 * len(shapes), 4.2))
    for ax, (name, g) in zip(axes, shapes.items()):
        L1, dir1, L2, dir2 = min_bounding_box(g)
        axis = basic_length_axis(g, L1, dir1, L2, dir2)
        g.plot(ax=ax, facecolor=FILL, edgecolor=INK, linewidth=1.2)
        gpd.GeoSeries(
            [g.geometry.iloc[0].minimum_rotated_rectangle], crs=g.crs
        ).plot(ax=ax, facecolor="none", edgecolor=BBOX, linestyle="-", linewidth=1.0)
        plot_dimension_arrows(ax, g, axis)
        ax.set_title(
            f"{name}\nL1={axis['L1'][0]:.1f} L2={axis['L2'][0]:.1f} "
            f"a1={axis['a1'][0]:.1f} a2={axis['a2'][0]:.1f} "
            f"b={axis['b'][0]:.1f} c={axis['c'][0]:.1f}",
            fontsize=9,
        )
        ax.set_aspect("equal")
        ax.set_axis_off()
    bbox_handle = Line2D([0], [0], color=BBOX, linewidth=1.0, label="bounding box")
    fig.legend(
        handles=dimension_legend_handles() + [bbox_handle],
        loc="lower center",
        ncol=7,
        bbox_to_anchor=(0.5, -0.06),
    )
    fig.suptitle("Basic plan dimensions L1, L2, a1, a2, b, c (bbox axis convention)", y=1.03)
    save(fig, FIGURES / "basic_lengths_idealized.jpg")


def save(fig, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    buf.seek(0)
    Image.open(buf).convert("RGB").save(path, quality=90, optimize=True, progressive=True)
    print(f"wrote {path}  ({path.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    fig_norm_compliance()
    fig_position_scenarios()
    fig_direction_methods()
    fig_basic_lengths()


if __name__ == "__main__":
    main()
