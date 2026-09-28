#!/usr/bin/env python3
"""One-off preprocessing: pilot-region gpkg -> SevillaConference/data/.

Mirrors BerlinConference/data/shape_parameters/prepare_shape_data.py, but
against SismicaUPM's three pilot-region datasets directly (Data/Datasets/)
rather than a per-conference "unified" gpkg, and additionally writes the
overlay geometry (footprint_attributes.visualization.overlays) needed by the
relative_position map's "Force arrows" toggle and the building_sizes map's
dimension arrows.

Writes, per dataset:
  data/shape_parameters/<name>/buildings.geojson    -- 15 shape metrics + slenderness
  data/relative_position/<name>/buildings.geojson   -- relativePosition + basics
  data/relative_position/<name>/overlays/position_arrows.geojson
  data/building_sizes/<name>/buildings.geojson       -- basics only (for the plain footprints layer)
  data/building_sizes/<name>/overlays/basic_lengths.geojson

Run with the footprint_attributes package's own venv:
  code/footprint_attributes/.venv/bin/python prepare_data.py
"""
import os
import sys

sys.path.insert(0, "/home/miguel/Documents/Proyectos/SismicaUPM/code/footprint_attributes/src")

import geopandas as gpd
import pandas as pd
import shapely
from shapely.affinity import scale as shapely_scale
from shapely.geometry import Polygon
from footprint_attributes import position, shape
from footprint_attributes.geometry import ensure_projected, to_gdf
from footprint_attributes.visualization.overlays import build_overlays

# Both the resultant and per-edge contact-force vectors can be many times a
# building's own size (they're force magnitudes, not real physical lengths)
# -- shrink them toward their own start point so they read as arrows on the
# building rather than lines shooting off across the map. Individual wall
# forces are NOT shrunk as hard as first tried (0.08): at that scale, with
# a dashed stroke and an arrowhead sized as a fraction of an already-tiny
# shaft, several edge arrows sharing one wall collapsed into an illegible
# starburst of dashes rather than reading as arrows.
#
# The scale factors are NEGATIVE on purpose: footprint_attributes.position's
# raw contact_force_vectors point from the subject building's own centroid
# TOWARD the neighbour pressing on it (verified directly against
# position.contact_force_vectors -- the vector's direction has cosine
# similarity ~0.95-1.0 with the direction to the actual touching neighbour).
# That reads backwards on the map: a "point away from what's pushing you"
# convention (the direction the building is being shoved) is the one that
# matches what people expect a contact-force arrow to show. Since
# shapely.affinity.scale with a negative factor is a point-reflection
# through the origin, using a negative scale here both shrinks the arrow
# AND flips it 180 degrees in one step -- the arrowhead's own shape (built
# symmetrically around the shaft) still comes out looking like a proper
# arrowhead after a 180-degree rotation, just pointing the other way.
RESULTANT_LENGTH_SCALE = -0.3
EDGE_LENGTH_SCALE = -0.35


def shorten_geom(geom, scale):
    origin = shapely.get_parts(geom)[0].coords[0]
    return shapely_scale(geom, xfact=scale, yfact=scale, origin=origin)


def split_shaft_head(geom):
    """Split an arrow_gdf caps="arrow" MultiLineString into its plain shaft
    (part 0: the line from tail to tip) and a FILLED triangle Polygon built
    from the tip and its two arrowhead barb endpoints (parts 1-2).

    A filled triangle stays legible at any zoom level -- two thin
    diverging strokes (arrow_gdf's own two-line barb construction) blur
    into a formless smudge once the whole arrow is only a few screen
    pixels long, especially once a dash pattern is layered on top. A solid
    triangle icon degrades gracefully instead: it just gets smaller.
    """
    parts = shapely.get_parts(geom)
    shaft = parts[0]
    tip = shapely.get_coordinates(parts[0])[-1]
    back1 = shapely.get_coordinates(parts[1])[-1]
    back2 = shapely.get_coordinates(parts[2])[-1]
    head = Polygon([tip, back1, back2])
    return shaft, head

DATA_ROOT = "/home/miguel/Documents/Proyectos/SismicaUPM/Data/Datasets"
OUT_ROOT = "/home/miguel/Documents/Proyectos/SismicaUPM/SevillaConference/data"

# dataset id -> (source gpkg, display label)
DATASETS = {
    "mata_redonda": ("san_jose_pilot_region.gpkg", "Mata Redonda"),
    "quisquella": ("santo_domingo_pilot_region.gpkg", "Quisquella"),
    "zona_1": ("guatemala_pilot_region.gpkg", "Zona 1"),
}

SHAPE_COLUMNS = [
    "EC8_eccentricityRatio", "EC8_radiusRatio", "EC8_compactness",
    "ASCE7_setbackRatio", "ASCE7_holeRatio", "ASCE7_parallelityAngle",
    "GNDTII_beta1_mainShapeSlenderness", "GNDTII_beta2_setbackRatio",
    "GNDTII_beta4_eccentricityRatio", "GNDTII_beta6_setbackSlenderness",
    "CSCR2010_eccentricityRatio",
    "NTC23_setbackRatio", "NTC23_holeRatio",
]
SLENDERNESS_COLUMNS = ["slenderness_bbox", "slenderness_inertia"]

# Source columns present on the pilot-region gpkgs (see Data/Datasets/*.gpkg):
# id, city, height, n_storeys, year, code_quality, structural_system,
# simplified_structural_system, roof, geometry.
RENAME = {"id": "building_uid", "n_storeys": "n_floors", "roof": "roof_material"}
EXTRA_COLUMNS = ["building_uid", "height", "n_floors", "structural_system", "roof_material"]


def to_largest_polygon(geom):
    """make_valid() on a self-intersecting footprint can return a
    GeometryCollection (polygon + a degenerate line/point sliver);
    footprint_attributes requires pure Polygon geometry, so keep only the
    largest polygonal part."""
    if geom.geom_type == "Polygon":
        return geom
    parts = [g for g in shapely.get_parts(geom) if g.geom_type in ("Polygon", "MultiPolygon")]
    if not parts:
        return geom
    polys = []
    for p in parts:
        polys.extend(list(p.geoms) if p.geom_type == "MultiPolygon" else [p])
    return max(polys, key=lambda p: p.area)


def main():
    for name, (src, label) in DATASETS.items():
        print(f"=== {name} ({label}) ===")
        raw = gpd.read_file(f"{DATA_ROOT}/{src}")
        raw = raw.rename(columns=RENAME)
        n_before = len(raw)
        raw = raw[raw.geometry.notna() & ~raw.geometry.is_empty].reset_index(drop=True)
        if len(raw) != n_before:
            print(f"  dropped {n_before - len(raw)} rows with missing/empty geometry")

        gdf = raw[["building_uid", "geometry"]].copy()
        gdf.geometry = gdf.geometry.make_valid()
        gdf = ensure_projected(to_gdf(gdf))
        gdf.geometry = gdf.geometry.make_valid()
        gdf.geometry = gdf.geometry.apply(to_largest_polygon)

        result = shape(gdf, columns=[*SHAPE_COLUMNS, *SLENDERNESS_COLUMNS])
        result["building_uid"] = gdf["building_uid"].values
        # footprint_attributes.position's output column was renamed
        # relativePosition -> blockPosition; keep this pipeline's own output
        # column named relativePosition since every SevillaConference map's
        # JS still reads that property name.
        result["relativePosition"] = position(gdf)["blockPosition"].values

        for c in [*SHAPE_COLUMNS, *SLENDERNESS_COLUMNS]:
            print(f"  {c}: {result[c].notna().sum()}/{len(result)}")
        print("  relativePosition counts:", result["relativePosition"].value_counts().to_dict())

        result = result.to_crs(epsg=4326)

        extra = raw[EXTRA_COLUMNS].copy()
        merged = result.merge(extra, on="building_uid", how="left")

        shape_dir = f"{OUT_ROOT}/shape_parameters/{name}"
        os.makedirs(shape_dir, exist_ok=True)
        merged.to_file(f"{shape_dir}/buildings.geojson", driver="GeoJSON")
        print(f"  wrote {shape_dir}/buildings.geojson")

        pos_cols = ["building_uid", "relativePosition", "height", "n_floors", "structural_system", "roof_material", "geometry"]
        pos_dir = f"{OUT_ROOT}/relative_position/{name}"
        os.makedirs(pos_dir, exist_ok=True)
        merged[pos_cols].to_file(f"{pos_dir}/buildings.geojson", driver="GeoJSON")
        print(f"  wrote {pos_dir}/buildings.geojson")

        size_dir = f"{OUT_ROOT}/building_sizes/{name}"
        os.makedirs(size_dir, exist_ok=True)
        merged[pos_cols].to_file(f"{size_dir}/buildings.geojson", driver="GeoJSON")
        print(f"  wrote {size_dir}/buildings.geojson")

        # Overlay geometry: contact-force arrows (relative_position map) and
        # basic-length dimension arrows (building_sizes map). build_overlays
        # needs a projected gdf with an "id" column (its own building
        # identifier convention) + height.
        overlay_src = gdf.merge(extra[["building_uid", "height"]], on="building_uid", how="left")
        overlay_src = overlay_src.rename(columns={"building_uid": "id"})
        overlays = build_overlays(overlay_src, height_column="height")

        pos_overlay_dir = f"{pos_dir}/overlays"
        os.makedirs(pos_overlay_dir, exist_ok=True)
        position_arrows = overlays["position_arrows"].rename(columns={"id": "building_uid"})
        is_resultant = position_arrows["kind"] == "contact_force_resultant"
        is_edge = position_arrows["kind"] == "contact_force_edge"

        def shaft_head_rows(rows, scale):
            rows = rows.copy()
            rows["geometry"] = rows["geometry"].apply(shorten_geom, scale=scale)
            shaft_and_head = rows["geometry"].apply(split_shaft_head)
            shaft_rows = rows.copy()
            shaft_rows["geometry"] = [s for s, _ in shaft_and_head]
            shaft_rows["part"] = "shaft"
            head_rows = rows.copy()
            head_rows["geometry"] = [h for _, h in shaft_and_head]
            head_rows["part"] = "head"
            return shaft_rows, head_rows

        resultant_shaft, resultant_head = shaft_head_rows(position_arrows.loc[is_resultant], RESULTANT_LENGTH_SCALE)
        edge_shaft, edge_head = shaft_head_rows(position_arrows.loc[is_edge], EDGE_LENGTH_SCALE)

        position_arrows = gpd.GeoDataFrame(
            pd.concat([resultant_shaft, resultant_head, edge_shaft, edge_head], ignore_index=True),
            crs=position_arrows.crs,
        )
        position_arrows.to_crs(epsg=4326).to_file(f"{pos_overlay_dir}/position_arrows.geojson", driver="GeoJSON")
        print(f"  wrote {pos_overlay_dir}/position_arrows.geojson")

        size_overlay_dir = f"{size_dir}/overlays"
        os.makedirs(size_overlay_dir, exist_ok=True)
        basic_lengths = overlays["basic_lengths"].rename(columns={"id": "building_uid"})
        basic_lengths.to_crs(epsg=4326).to_file(f"{size_overlay_dir}/basic_lengths.geojson", driver="GeoJSON")
        print(f"  wrote {size_overlay_dir}/basic_lengths.geojson")

        basic_lengths_inertia = overlays["basic_lengths_inertia"].rename(columns={"id": "building_uid"})
        basic_lengths_inertia.to_crs(epsg=4326).to_file(f"{size_overlay_dir}/basic_lengths_inertia.geojson", driver="GeoJSON")
        print(f"  wrote {size_overlay_dir}/basic_lengths_inertia.geojson")

        inertia_axis = overlays["inertia_axis"].rename(columns={"id": "building_uid"})
        inertia_axis.to_crs(epsg=4326).to_file(f"{size_overlay_dir}/inertia_axis.geojson", driver="GeoJSON")
        print(f"  wrote {size_overlay_dir}/inertia_axis.geojson")


if __name__ == "__main__":
    main()
