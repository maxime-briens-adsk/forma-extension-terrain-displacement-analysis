import * as THREE from "three";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";
import {
  createCanvas,
  initializeBlankCanvas,
} from "../../services/Visualize.ts";
import { useCallback } from "preact/hooks";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CANVAS_NAME } from "../../App.tsx";
import { saveCanvas, saveFloatArray } from "../../services/Storage.ts";
import { Group, Mesh } from "three";
import { cartesian } from "../../utils/misc.ts";
// @ts-ignore
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { rotationMatrixYUpToZUp } from "./Download.tsx";
import {
  deltaMass,
  elevation,
  identicalTerrains,
  inputScale,
  loadingData,
  TERRAIN_BUFFER,
  TERRAIN_DIFF_THRESHOLD,
} from "../../state/application-state.ts";
import { Footprint } from "forma-embedded-view-sdk/geometry";

type Props = {
  otherTerrainUrn: string;
};

async function getTerrainUrn() {
  const terrainUrns = await Forma.geometry.getPathsByCategory({
    category: "terrain",
  });
  if (!terrainUrns || terrainUrns.length === 0) {
    console.error("No terrain found");
    loadingData.value = false;
    throw new Error("No terrain found");
  }
  return terrainUrns[0];
}

async function getTerrainElement(urn: string | undefined) {
  if (!urn) {
    const path = await getTerrainUrn();
    const result = await Forma.elements.getByPath({ path });
    return result.element;
  } else {
    const result = await Forma.elements.get({ urn });
    return result.element;
  }
}

async function loadTerrain(
  terrainUrn: string | undefined,
): Promise<Group | undefined> {
  const element = await getTerrainElement(terrainUrn);
  const volume = await Forma.elements.representations.volumeMesh(element);
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(volume?.data, "");
  gltf.scene.applyMatrix4(rotationMatrixYUpToZUp());
  gltf.scene.updateMatrixWorld();
  const material = new THREE.MeshBasicMaterial();
  material.side = THREE.DoubleSide;

  gltf.scene.traverse((o: any) => {
    if (o instanceof Mesh) {
      o.name = "analyzedMesh";
      o.geometry.computeVertexNormals();
      o.receiveShadow = true;
      o.castShadow = false;
      o.material = material;

      o.geometry.computeBoundsTree = computeBoundsTree;
      o.geometry.disposeBoundsTree = disposeBoundsTree;
      o.geometry.computeBoundsTree();
      o.raycast = acceleratedRaycast;
    }
  });
  return gltf.scene;
}

async function getSelectedSiteLimits() {
  const [selectedPaths, siteLimitPaths, zonePath] = await Promise.all([
    Forma.selection.getSelection(),
    Forma.geometry.getPathsByCategory({ category: "site_limit" }),
    Forma.geometry.getPathsByCategory({ category: "zone" }),
  ]);

  const selectedSiteLimitsPaths = selectedPaths.filter(
    (path) => siteLimitPaths.includes(path) || zonePath.includes(path),
  );
  if (!selectedSiteLimitsPaths || selectedSiteLimitsPaths.length === 0) {
    return;
  }
  const fetchPromises: Promise<Footprint | undefined>[] = [];
  selectedPaths.forEach((path) => {
    fetchPromises.push(Forma.geometry.getFootprint({ path }));
  });
  return await Promise.all(fetchPromises);
}

function getBoundingBox(
  newTerrain: Group,
  selectedSiteLimits: (Footprint | undefined)[] | undefined,
) {
  const bBox = new THREE.Box3().setFromObject(newTerrain);
  if (
    !selectedSiteLimits ||
    selectedSiteLimits.filter((siteLimit) => siteLimit).length === 0
  ) {
    return bBox;
  }
  let xCoords: number[] = [];
  let yCoords: number[] = [];
  for (const siteLimit of selectedSiteLimits) {
    if (!siteLimit) continue;
    siteLimit.coordinates.forEach((coord) => {
      xCoords.push(coord[0]);
      yCoords.push(coord[1]);
    });
  }
  return new THREE.Box3(
    new THREE.Vector3(Math.min(...xCoords), Math.min(...yCoords), bBox.min.z),
    new THREE.Vector3(Math.max(...xCoords), Math.max(...yCoords), bBox.max.z),
  );
}

async function computeElevationDiff(
  x: number,
  y: number,
  newMesh: Group,
  oldMesh: Group,
  maxHeight: number | undefined,
): Promise<[string, number]> {
  const origin = new THREE.Vector3(x, y, maxHeight ? maxHeight + 10 : 10000);
  const direction = new THREE.Vector3(0, 0, -1);
  let raycaster = new THREE.Raycaster();
  raycaster.set(origin, direction);
  const oldIntersection = raycaster.intersectObjects(oldMesh.children)[0];
  const newIntersection = raycaster.intersectObjects(newMesh.children)[0];
  if (!oldIntersection || !newIntersection) {
    return [`${x}, ${y}`, NaN];
  }
  return [
    `${x}, ${y}`,
    newIntersection?.point.z - oldIntersection?.point.z - TERRAIN_BUFFER || NaN,
  ];
}

function sameTerrains() {
  console.log("Both terrains are identical");
  identicalTerrains.value = true;
  elevation.value = undefined;
  deltaMass.value = undefined;
  loadingData.value = false;
}

export default function CalculateAndStore({ otherTerrainUrn }: Props) {
  const calculateTerrainDifference = useCallback(async () => {
    loadingData.value = true;
    identicalTerrains.value = false;
    const [newTerrain, oldTerrain] = await Promise.all([
      loadTerrain(undefined),
      loadTerrain(otherTerrainUrn),
    ]);
    if (!newTerrain || !oldTerrain) {
      console.error("Failed to load terrain");
      elevation.value = undefined;
      deltaMass.value = undefined;
      loadingData.value = false;
      return;
    }

    // Add buffer to avoid Z-fighting and get better raycasting results
    newTerrain.position.set(
      newTerrain.position.x,
      newTerrain.position.y,
      newTerrain.position.z + TERRAIN_BUFFER,
    );

    const selectedSiteLimits = await getSelectedSiteLimits();

    const bBox = getBoundingBox(newTerrain, selectedSiteLimits);
    // if ((bBox.max.x - bBox.min.x <= RAPIDRAYCASTTHRESHOLD) && (bBox.max.y - bBox.min.y <= RAPIDRAYCASTTHRESHOLD)) {
    //   useRapidRayCast.value = false;
    // }
    const diffX = Math.floor((bBox.max.x - bBox.min.x) / inputScale.value);
    const diffY = Math.floor((bBox.max.y - bBox.min.y) / inputScale.value);
    const coordsX = Array.from(
      { length: diffX },
      (_, i) => bBox.min.x + i * inputScale.value,
    );
    const coordsY = Array.from(
      { length: diffY },
      (_, i) => bBox.min.y + i * inputScale.value,
    );

    console.log("start computing elevation diff");
    const fetchPromises = [];
    for (const [x, y] of cartesian(coordsX, coordsY)) {
      fetchPromises.push(
        computeElevationDiff(x, y, newTerrain, oldTerrain, bBox.max.z),
      );
    }
    const result: { [k: string]: number } = Object.fromEntries(
      await Promise.all(fetchPromises),
    );
    console.log("Done with elevation diff");

    let elevationDiff = new Float32Array(diffX * diffY).fill(NaN);
    let minElevation = Number.POSITIVE_INFINITY;
    let maxElevation = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < diffX; i++) {
      const coordY = bBox.min.y + inputScale.value * i;
      for (let j = 0; j < diffY; j++) {
        const coordX = bBox.min.x + inputScale.value * j;
        const delta = result[`${coordX}, ${coordY}`];
        elevationDiff[i * diffX + j] = delta;
        if (delta || delta === 0) {
          minElevation = Math.min(delta, minElevation);
          maxElevation = Math.max(delta, maxElevation);
        }
      }
    }

    // verify if all delta values are != 0 (given a buffer)
    const isSameTerrain =
      minElevation === maxElevation ||
      maxElevation - minElevation < TERRAIN_DIFF_THRESHOLD;
    if (isSameTerrain) {
      sameTerrains();
    }

    const canvas = isSameTerrain
      ? initializeBlankCanvas()
      : createCanvas(elevationDiff, diffX, diffY, minElevation, maxElevation);

    // need to find the reference point of the terrain to place the canvas
    // for this analysis, it's the middle of the terrain
    const position = {
      x: bBox.min.x + (diffX * inputScale.value) / 2,
      y: bBox.max.y - (diffY * inputScale.value) / 2,
      z: 29, // need to put the texture higher up than original
    };

    await Forma.terrain.groundTexture.add({
      name: CANVAS_NAME,
      canvas,
      position,
      scale: { x: inputScale.value, y: inputScale.value },
    });
    await saveCanvas("terrain-steepness-png", canvas, {
      minX: bBox.min.x,
      maxX: bBox.max.x,
      minY: bBox.min.y,
      maxY: bBox.max.y,
    });
    await saveFloatArray("terrain-steepness-raw", elevationDiff, {
      minElevation,
      maxElevation,
      diffX,
      diffY,
      minX: bBox.min.x,
      maxX: bBox.max.x,
      minY: bBox.min.y,
      maxY: bBox.max.y,
    });
  }, [otherTerrainUrn]);

  return (
    <button
      onClick={calculateTerrainDifference}
      style="width: 100%;"
      disabled={loadingData.value}
      onMouseOver={() =>
        loadingData.value ? "Calculations in progress, please wait" : ""
      }
    >
      Calculate elevation difference
    </button>
  );
}
