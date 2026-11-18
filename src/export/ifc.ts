/**
 * Plan → IFC4 (a STEP physical file), for BIM tools.
 *
 *   IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey
 *     walls      IfcWall, one extruded footprint each (mitred into its joints)
 *     openings   IfcOpeningElement voiding its wall, filled by an IfcDoor / IfcWindow
 *     floors     IfcSlab per room
 *     rooms      IfcSpace, with name and floor areas
 *     furniture  IfcFurnishingElement boxes
 *
 * Always in meters (IFC readers convert for display); +x east, +y north, +z up —
 * the plan's y is flipped. GlobalIds are derived from the plan's own ids, so
 * exporting the same plan twice gives the same file. Pure.
 */
import { openingHeights } from '../build';
import { levelsOf } from '../levels';
import type { PlanData, Point } from '../types';
import { buildModel } from './model';
import { fileStem } from './text';
import { loopArea } from './walls';

const SLAB = 0.2;
const DOOR_LEAF = 0.04;
const GLASS = 0.03;

// ---------- STEP value formatting ----------

/** A REAL: always with a decimal point, never an exponent, at most 6 decimals. */
export function real(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  let s = v.toFixed(6).replace(/0+$/, '');
  if (s === '-0.') s = '0.';
  return s;
}

/** A STRING: quotes doubled, backslashes doubled, anything outside printable ASCII as \X2\…\X0\. */
export function str(text: string): string {
  let out = "'";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }
  return out + "'";
}

// ---------- GlobalIds ----------

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Two independent 32-bit hashes of a string (cyrb-style mixing). */
function hash64(text: string, seed: number): [number, number] {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

/** A 22-character IFC GlobalId (a 128-bit number in IFC's base 64) derived from `key`. */
export function globalId(key: string): string {
  const words = [...hash64(key, 1), ...hash64(key, 2)];
  const bits: number[] = [];
  for (const w of words) for (let i = 31; i >= 0; i--) bits.push((w >>> i) & 1);
  let out = B64[(bits[0] << 1) | bits[1]];
  for (let i = 2; i < 128; i += 6) {
    let v = 0;
    for (let k = 0; k < 6; k++) v = (v << 1) | bits[i + k];
    out += B64[v];
  }
  return out;
}

// ---------- the writer ----------

export interface IfcOptions {
  /** Time stamp for the file header. Defaults to now. */
  date?: Date;
}

export function planToIfc(plan: PlanData, opts: IfcOptions = {}): string {
  const model = buildModel(plan);
  const H = model.settings.wallHeight;
  const T = model.body.thickness;

  const data: string[] = [];
  const add = (entity: string): string => {
    data.push(entity);
    return `#${data.length}`;
  };
  const list = (refs: string[]): string => `(${refs.join(',')})`;

  const used = new Set<string>();
  const guid = (key: string): string => {
    let id = globalId(key);
    for (let n = 1; used.has(id); n++) id = globalId(`${key}#${n}`);
    used.add(id);
    return `'${id}'`;
  };

  const point3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`);
  const point2 = (x: number, y: number) => add(`IFCCARTESIANPOINT((${real(x)},${real(y)}))`);
  const dir3 = (x: number, y: number, z: number) => add(`IFCDIRECTION((${real(x)},${real(y)},${real(z)}))`);

  // ----- shared geometry, units, context -----
  const origin = point3(0, 0, 0);
  const up = dir3(0, 0, 1);
  const east = dir3(1, 0, 0);
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${up},${east})`);
  const origin2 = point2(0, 0);
  const axes2 = add(`IFCAXIS2PLACEMENT2D(${origin2},$)`);

  const units = add(
    `IFCUNITASSIGNMENT(${list([
      add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'),
      add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
      add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
      add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
    ])})`,
  );
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${world},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$)`);

  /** A placement relative to another: origin and (optionally) the direction of its x axis, z staying up. */
  const placement = (relativeTo: string | null, x: number, y: number, z: number, xAxis?: { x: number; y: number }): string => {
    const at = x === 0 && y === 0 && z === 0 ? origin : point3(x, y, z);
    const axis = xAxis ? add(`IFCAXIS2PLACEMENT3D(${at},${up},${dir3(xAxis.x, xAxis.y, 0)})`) : at === origin ? world : add(`IFCAXIS2PLACEMENT3D(${at},${up},${east})`);
    return add(`IFCLOCALPLACEMENT(${relativeTo ?? '$'},${axis})`);
  };

  /** An outline (local 2D points) extruded straight up → product shape. */
  const extrude = (profile: string, height: number): string => {
    const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${world},${up},${real(height)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const polygonProfile = (pts: { x: number; y: number }[]): string => {
    // Counter-clockwise, closed by repeating the first point.
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      area += p.x * q.y - q.x * p.y;
    }
    const ordered = area < 0 ? pts.slice().reverse() : pts;
    const refs = ordered.map((p) => point2(p.x, p.y));
    refs.push(refs[0]);
    return add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${add(`IFCPOLYLINE(${list(refs)})`)})`);
  };
  const rectProfile = (w: number, d: number): string => add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${axes2},${real(w)},${real(d)})`);
  /** Plan point → IFC world x, y. */
  const flip = (p: Point) => ({ x: p.x, y: -p.y });

  // ----- spatial structure -----
  const name = model.name || 'Plan';
  const project = add(`IFCPROJECT(${guid(`project|${name}`)},$,${str(name)},$,$,$,$,(${context}),${units})`);
  const sitePlc = placement(null, 0, 0, 0);
  const site = add(`IFCSITE(${guid(`site|${name}`)},$,'Site',$,$,${sitePlc},$,$,.ELEMENT.,$,$,$,$,$)`);
  const buildingPlc = placement(sitePlc, 0, 0, 0);
  const building = add(`IFCBUILDING(${guid(`building|${name}`)},$,${str(name)},$,$,${buildingPlc},$,$,.ELEMENT.,$,$,$)`);
  const storeyPlc = placement(buildingPlc, 0, 0, 0);
  const storey = add(`IFCBUILDINGSTOREY(${guid(`storey|${name}`)},$,'Ground floor',$,$,${storeyPlc},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES(${guid('agg|project')},$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${guid('agg|site')},$,$,$,${site},(${building}))`);
  add(`IFCRELAGGREGATES(${guid('agg|building')},$,$,$,${building},(${storey}))`);

  const contained: string[] = [];

  // ----- walls, with their openings, doors and windows -----
  // Each wall stands its own levels high (levels.ts); a window repeats on every level, a door stays on the ground.
  const levels = new Map(plan.walls.map((w) => [w.id, levelsOf(w)]));
  model.body.runs.forEach((run, i) => {
    const d = run.dir;
    const n = { x: -d.y, y: d.x };
    const wallPlc = placement(storeyPlc, run.origin.x, -run.origin.y, 0, { x: d.x, y: -d.y });
    const local = run.poly.map((p) => {
      const vx = p.x - run.origin.x;
      const vy = p.y - run.origin.y;
      return { x: vx * d.x + vy * d.y, y: -(vx * n.x + vy * n.y) };
    });
    const key = `${run.wallId}|${Math.round(run.s0 * 1000)}`;
    const rows = levels.get(run.wallId) ?? 1;
    const wall = add(
      `IFCWALL(${guid(`wall|${key}`)},$,${str(`Wall ${i + 1}`)},$,$,${wallPlc},${extrude(polygonProfile(local), H * rows)},$,.NOTDEFINED.)`,
    );
    contained.push(wall);

    for (const gap of model.openings) {
      if (gap.wallId !== run.wallId || gap.left < run.s0 - 1e-6 || gap.right > run.s1 + 1e-6) continue;
      const { y0, y1 } = openingHeights(gap.type, H);
      const height = y1 - y0;
      const mid = (gap.left + gap.right) / 2;
      for (let level = 0; level < (gap.type === 'window' ? rows : 1); level++) {
        // The ground row keeps the opening's own id, so a one-level plan writes the same file as ever.
        const id = level === 0 ? gap.id : `${gap.id}|level ${level + 1}`;
        const openingPlc = placement(wallPlc, mid, 0, y0 + level * H);
        const opening = add(
          `IFCOPENINGELEMENT(${guid(`opening|${id}`)},$,'Opening',$,$,${openingPlc},${extrude(rectProfile(gap.width, T + 0.1), height)},$,.OPENING.)`,
        );
        add(`IFCRELVOIDSELEMENT(${guid(`voids|${id}`)},$,$,$,${wall},${opening})`);
        const fillPlc = placement(openingPlc, 0, 0, 0);
        const filling =
          gap.type === 'door'
            ? add(
                `IFCDOOR(${guid(`door|${id}`)},$,${str(gap.label ?? 'Door')},$,$,${fillPlc},${extrude(rectProfile(gap.width, DOOR_LEAF), height)},$,${real(height)},${real(gap.width)},.DOOR.,.SINGLE_SWING_LEFT.,$)`,
              )
            : add(
                `IFCWINDOW(${guid(`window|${id}`)},$,${str(gap.label ?? 'Window')},$,$,${fillPlc},${extrude(rectProfile(gap.width, GLASS), height)},$,${real(height)},${real(gap.width)},.WINDOW.,.SINGLE_PANEL.,$)`,
              );
        add(`IFCRELFILLSELEMENT(${guid(`fills|${id}`)},$,$,$,${opening},${filling})`);
        contained.push(filling);
      }
    }
  });

  // ----- rooms: a floor slab and a space each -----
  const spaces: string[] = [];
  const slabPlc = model.rooms.length > 0 ? placement(storeyPlc, 0, 0, -SLAB) : '';
  for (const room of model.rooms) {
    contained.push(
      add(
        `IFCSLAB(${guid(`slab|${room.key}`)},$,${str(`Floor, ${room.name}`)},$,$,${slabPlc},${extrude(polygonProfile(room.polygon.map(flip)), SLAB)},$,.FLOOR.)`,
      ),
    );
    const outline = room.net ?? room.polygon;
    const space = add(
      `IFCSPACE(${guid(`space|${room.key}`)},$,${str(room.name)},$,$,${storeyPlc},${extrude(polygonProfile(outline.map(flip)), H)},${str(room.name)},.ELEMENT.,.INTERNAL.,$)`,
    );
    spaces.push(space);
    const quantities = [
      add(`IFCQUANTITYAREA('GrossFloorArea',$,$,${real(room.area)},$)`),
      add(`IFCQUANTITYAREA('NetFloorArea',$,$,${real(room.net ? Math.abs(loopArea(room.net)) : room.area)},$)`),
      add(`IFCQUANTITYLENGTH('Height',$,$,${real(H)},$)`),
    ];
    const qto = add(`IFCELEMENTQUANTITY(${guid(`qto|${room.key}`)},$,'Qto_SpaceBaseQuantities',$,$,${list(quantities)})`);
    add(`IFCRELDEFINESBYPROPERTIES(${guid(`qtorel|${room.key}`)},$,$,$,(${space}),${qto})`);
  }
  if (spaces.length > 0) add(`IFCRELAGGREGATES(${guid('agg|storey')},$,$,$,${storey},${list(spaces)})`);

  // ----- furniture -----
  for (const item of model.furniture) {
    const c = Math.cos(item.rotation);
    const s = Math.sin(item.rotation);
    // Raised to what it stands on: a plate sits on the table, not in it.
    const plc = placement(storeyPlc, item.x, -item.y, Number.isFinite(item.z) ? item.z : 0, { x: c, y: -s });
    const label = item.tag ? `${item.label} (${item.tag})` : item.label;
    contained.push(
      add(
        `IFCFURNISHINGELEMENT(${guid(`furniture|${item.id}`)},$,${str(label)},${item.source?.url ? str(item.source.url) : '$'},${str(item.kind)},${plc},${extrude(rectProfile(item.w, item.d), Math.max(0.01, item.h))},$)`,
      ),
    );
  }

  if (contained.length > 0) {
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contains|storey')},$,$,$,${list(contained)},${storey})`);
  }

  const date = opts.date ?? new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');",
    `FILE_NAME(${str(`${fileStem(name)}.ifc`)},'${stamp}',(''),(''),'Gaudi','Gaudi','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ];
  const lines = data.map((entity, i) => `#${i + 1}=${entity};`);
  return [...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n') + '\n';
}
