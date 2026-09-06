import * as THREE from 'three';
import {
  MEMBER, BUILD_REACH, memberRecord, quarterYaw, memberBounds, localPoint, worldPoint,
  containsXZ, groundedPlacement, canPlaceMember, canRemoveMember, validateHomestead,
} from './homestead-rules.js';

const roundGrid = (value, size) => Math.round(value / size) * size;

function memberGeometry(form) {
  const d = MEMBER[form];
  // Contact faces reach the full structural dimensions. The chamfered
  // profile makes a shallow joint groove without an open slit through the
  // whole wall/roof; shrinking every member left centimetre-wide sky gaps.
  const w = d.width, h = d.height, bevel = form === 'block' ? 0.018 : 0.014;
  const profile = new THREE.Shape();
  profile.moveTo(-w / 2 + bevel, -h / 2);
  profile.lineTo(w / 2 - bevel, -h / 2);
  profile.lineTo(w / 2, -h / 2 + bevel);
  profile.lineTo(w / 2, h / 2 - bevel);
  profile.lineTo(w / 2 - bevel, h / 2);
  profile.lineTo(-w / 2 + bevel, h / 2);
  profile.lineTo(-w / 2, h / 2 - bevel);
  profile.lineTo(-w / 2, -h / 2 + bevel);
  profile.closePath();
  const geo = new THREE.ExtrudeGeometry(profile, {
    depth: d.length, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  geo.translate(0, 0, -d.length / 2);
  geo.rotateY(Math.PI / 2);
  // One material/draw per member. Texture coordinates are in metres, so a
  // block does not acquire the wildly stretched texture of a long beam.
  geo.clearGroups();
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.8, uv.getY(i) * 0.8);
  return geo;
}

/** Separate, load-bearing pieces. The caller owns inventory and save timing. */
export class Homestead {
  constructor(scene, { groundAt = () => 0, avoid = [], obstacles = () => [], materials = {} } = {}) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.avoid = avoid;
    this.obstacles = obstacles;
    this.group = new THREE.Group();
    this.group.name = 'Homestead';
    this.entries = [];
    this.colliders = [];
    // Three clones userData through JSON during scene warm-up. An entry owns
    // its mesh, so the reverse lookup must live outside serializable userData.
    this._entryByMesh = new WeakMap();
    this._nextId = 1;
    this._ray = new THREE.Raycaster();
    this._direction = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._geometry = Object.fromEntries(Object.keys(MEMBER).map((form) => [form, memberGeometry(form)]));
    this._fallback = {
      timber: new THREE.MeshStandardMaterial({ color: 0x886b49, roughness: 0.96 }),
      block: new THREE.MeshStandardMaterial({ color: 0x737b80, roughness: 1 }),
    };
    this.materials = { ...this._fallback, ...materials };
    scene.add(this.group);
  }

  setMaterials(materials) {
    for (const kind of ['timber', 'block']) if (materials[kind]) this.materials[kind] = materials[kind];
    for (const entry of this.entries) entry.mesh.material = this.materials[entry.kind];
  }

  _hit(camera, maxDistance = BUILD_REACH) {
    this.group.updateMatrixWorld(true);
    camera.getWorldDirection(this._direction);
    this._ray.set(camera.position, this._direction);
    this._ray.near = 0;
    this._ray.far = maxDistance;
    return this._ray.intersectObjects(this.group.children, false)[0] || null;
  }

  pickTarget(camera, maxDistance = BUILD_REACH) {
    const hit = this._hit(camera, maxDistance);
    if (!hit) return null;
    const ref = this._entryByMesh.get(hit.object);
    return { kind: 'construction', ref, dist: hit.distance, distance: hit.distance,
      point: hit.point.clone(), removable: this.canRemove(ref) };
  }

  _valid(proposal, playerPosition) {
    return proposal && canPlaceMember(proposal, this.entries, {
      groundAt: this.groundAt, avoid: this.avoid, obstacles: this.obstacles(), playerPosition,
    });
  }

  // F is enough: a first piece lies across the view on the ground. Subsequent
  // pieces follow the member the player aims at; there is no ghost or menu.
  target(surface, camera, kind = 'timber', playerPosition) {
    if (!['timber', 'block'].includes(kind)) return null;
    const hit = this._hit(camera);
    const terrainPoint = surface?.point || surface?.position || surface;
    const terrainDistance = terrainPoint && Number.isFinite(terrainPoint.x)
      ? camera.position.distanceTo(new THREE.Vector3(terrainPoint.x, terrainPoint.y, terrainPoint.z)) : Infinity;
    const ownHit = hit && hit.distance <= terrainDistance + 0.08 ? hit : null;
    let proposal = null;
    if (ownHit) {
      this._normal.copy(ownHit.face.normal).transformDirection(ownHit.object.matrixWorld);
      proposal = this._next(this._entryByMesh.get(ownHit.object), ownHit.point, this._normal, camera, kind, playerPosition);
    } else if (terrainPoint && terrainDistance <= BUILD_REACH && (surface.normal?.y ?? 1) > 0.55) {
      camera.getWorldDirection(this._direction);
      const yaw = quarterYaw(Math.atan2(-this._direction.x, -this._direction.z));
      proposal = groundedPlacement(kind, terrainPoint.x, terrainPoint.z, yaw, this.groundAt);
      // Aiming at ground near an existing member carries its alignment to the
      // next foundation, including the two side walls around an open doorway.
      const nearby = this.entries.filter((p) => p.form !== 'roof' && p.kind === kind)
        .sort((a, b) => Math.hypot(a.x - terrainPoint.x, a.z - terrainPoint.z) -
          Math.hypot(b.x - terrainPoint.x, b.z - terrainPoint.z))[0];
      if (nearby) {
        const local = localPoint(nearby, terrainPoint.x, terrainPoint.z);
        const d = MEMBER[nearby.form];
        if (Math.hypot(local.x, local.z) < d.length * 1.45) {
          const cell = kind === 'timber' ? 1.2 : 0.3;
          const snapped = worldPoint(nearby, roundGrid(local.x, cell), roundGrid(local.z, cell));
          const aligned = groundedPlacement(kind, snapped.x, snapped.z, yaw, this.groundAt);
          if (this._valid(aligned, playerPosition)) proposal = aligned;
        }
      }
    }
    return this._valid(proposal, playerPosition) ? Object.freeze(proposal) : null;
  }

  _next(base, point, normal, camera, kind, playerPosition) {
    const d = MEMBER[base.form], top = base.y + d.height / 2;
    const local = localPoint(base, point.x, point.z);
    const possibilities = [];
    const own = (form, x, y, z, yaw = base.yaw) => memberRecord({ kind, form, x, y, z, yaw });
    if (kind === 'timber' && base.form === 'roof') {
      // The visible seam itself is the ruler for the next roof board.
      const c = localPoint(base, camera.position.x, camera.position.z);
      const side = Math.sign(local.z) || Math.sign(c.z) || 1;
      for (const sign of [side, -side]) {
        const p = worldPoint(base, 0, sign * MEMBER.roof.width);
        possibilities.push(own('roof', p.x, base.y, p.z));
      }
    } else {
      if (kind === 'timber' && top - this.groundAt(base.x, base.z) >= 1.95 &&
          (normal.y > 0.35 || point.y > top - 0.11)) {
        const c = localPoint(base, camera.position.x, camera.position.z);
        // From inside, the near wall carries a board toward the opposite wall.
        const side = Math.sign(c.z) || Math.sign(local.z) || 1;
        const along = Math.max(-1.08, Math.min(1.08, roundGrid(local.x, MEMBER.roof.width)));
        for (const sign of [side, -side]) {
          const p = worldPoint(base, along, sign * MEMBER.beam.length / 2);
          possibilities.push(own('roof', p.x, top + MEMBER.roof.height / 2, p.z, base.yaw + Math.PI / 2));
        }
      }
      const form = kind === 'timber' ? 'beam' : 'block', next = MEMBER[form];
      const nearEnd = Math.abs(local.x) > d.length / 2 - Math.min(0.24, d.length * 0.3);
      if (nearEnd && normal.y < 0.6) {
        camera.getWorldDirection(this._direction);
        const carriedYaw = quarterYaw(Math.atan2(-this._direction.x, -this._direction.z));
        const sign = Math.sign(local.x) || 1;
        if (kind === 'timber' && base.form === 'beam' && Math.abs(carriedYaw - base.yaw) > 0.5) {
          const c = localPoint(base, camera.position.x, camera.position.z);
          const side = Math.sign(c.z) || 1;
          const p = worldPoint(base, sign * d.length / 2, side * next.length / 2);
          possibilities.push(own(form, p.x, base.y, p.z, carriedYaw));
        }
        const p = worldPoint(base, sign * (d.length + next.length) / 2, 0);
        possibilities.push(own(form, p.x, base.y, p.z));
      }
      if (normal.y < 0.4 && kind === 'block') {
        const side = Math.sign(local.z) || 1;
        const p = worldPoint(base, roundGrid(local.x, next.length / 2), side * (d.width + next.width) / 2);
        possibilities.push(own(form, p.x, base.y, p.z));
      }
      // Stagger masonry joints by half a block; beams keep their notch line.
      const offset = kind === 'block' ? roundGrid(local.x, next.length / 2) : 0;
      const p = worldPoint(base, offset, 0);
      possibilities.push(own(form, p.x, top + next.height / 2, p.z));
    }
    return possibilities.find((proposal) => this._valid(proposal, playerPosition)) || null;
  }

  place(kind, proposal, { playerPosition } = {}) {
    const record = memberRecord(proposal, kind);
    if (!this._valid(record, playerPosition)) return null;
    record.id = this._nextId++;
    return this._add(record);
  }

  _add(record) {
    const entry = { ...record };
    const mesh = new THREE.Mesh(this._geometry[entry.form], this.materials[entry.kind]);
    mesh.name = `Homestead-${entry.form}-${entry.id}`;
    mesh.position.set(entry.x, entry.y, entry.z);
    mesh.rotation.y = entry.yaw;
    mesh.castShadow = mesh.receiveShadow = true;
    this._entryByMesh.set(mesh, entry);
    entry.mesh = mesh;
    const d = MEMBER[entry.form], end = (d.length - d.width) / 2;
    const a = worldPoint(entry, -end, 0), b = worldPoint(entry, end, 0), bounds = memberBounds(entry);
    entry.collider = { x1: a.x, z1: a.z, x2: b.x, z2: b.z, r: d.width / 2,
      y0: bounds.y0, y1: bounds.y1 - 0.012 };
    this.entries.push(entry);
    this.colliders.push(entry.collider);
    this.group.add(mesh);
    return entry;
  }

  canRemove(entry) {
    return canRemoveMember(entry, this.entries, this.groundAt);
  }

  remove(entry) {
    if (!this.canRemove(entry)) return null;
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.colliders.splice(this.colliders.indexOf(entry.collider), 1);
    this._entryByMesh.delete(entry.mesh);
    this.group.remove(entry.mesh);
    return entry.kind;
  }

  floorHeightAt(x, z, maxY = Infinity) {
    let floor = null;
    for (const entry of this.entries) {
      const top = memberBounds(entry).y1;
      if (top <= maxY + 0.02 && containsXZ(entry, x, z) && (floor === null || top > floor)) floor = top;
    }
    return floor;
  }

  ceilingHeightAt(x, z, footY = -Infinity, radius = 0.3) {
    let ceiling = null;
    for (const piece of this.entries) {
      if (piece.form !== 'roof') continue;
      const bounds = memberBounds(piece);
      // Walking or landing on the upper face must never snap a body down
      // through the roof. Only a body that is below the board sees a ceiling.
      if (footY >= bounds.y0 - 0.015) continue;
      const p = localPoint(piece, x, z), d = MEMBER.roof;
      const dx = Math.max(0, Math.abs(p.x) - d.length / 2);
      const dz = Math.max(0, Math.abs(p.z) - d.width / 2);
      if (dx * dx + dz * dz > radius * radius) continue;
      if (ceiling === null || bounds.y0 < ceiling) ceiling = bounds.y0;
    }
    return ceiling;
  }

  resolve(position, radius = 0.3, height = 1.7) {
    let changed = false;
    for (let pass = 0; pass < 4; pass++) {
      for (const piece of this.entries) {
        // A board over the player's head is a ceiling, not a horizontal
        // capsule that ejects the player toward the nearest roof edge.
        if (piece.form === 'roof') continue;
        const box = memberBounds(piece), d = MEMBER[piece.form];
        if (position.y >= box.y1 - 0.02 || position.y + height <= box.y0) continue;
        const p = localPoint(piece, position.x, position.z);
        const cx = Math.max(-d.length / 2, Math.min(d.length / 2, p.x));
        const cz = Math.max(-d.width / 2, Math.min(d.width / 2, p.z));
        let dx = p.x - cx, dz = p.z - cz, distance = Math.hypot(dx, dz);
        if (distance >= radius) continue;
        if (distance < 1e-7) {
          if (d.length / 2 - Math.abs(p.x) < d.width / 2 - Math.abs(p.z)) {
            dx = (p.x < 0 ? -1 : 1) * (d.length / 2 + radius - Math.abs(p.x)); dz = 0;
          } else { dz = (p.z < 0 ? -1 : 1) * (d.width / 2 + radius - Math.abs(p.z)); dx = 0; }
        } else { dx *= (radius - distance) / distance; dz *= (radius - distance) / distance; }
        const world = worldPoint(piece, p.x + dx, p.z + dz);
        position.x = world.x; position.z = world.z;
        changed = true;
      }
    }
    const ceiling = this.ceilingHeightAt(position.x, position.z, position.y, radius);
    if (ceiling !== null && position.y + height > ceiling - 0.02) {
      position.y = ceiling - height - 0.02;
      changed = true;
    }
    return changed;
  }

  shelterAt(position) {
    const roofAt = (x, z) => this.entries.some((p) => p.form === 'roof' &&
      p.y > position.y + 0.08 && p.y < position.y + 4 && containsXZ(p, x, z));
    const samples = [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]];
    const coverage = samples.filter(([x, z]) => roofAt(position.x + x, position.z + z)).length / samples.length;
    if (!coverage) return 0;
    let walls = 0;
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      let blocked = false;
      for (let distance = 0.35; distance <= 3.2 && !blocked; distance += 0.12) {
        const x = position.x + Math.cos(angle) * distance, z = position.z + Math.sin(angle) * distance;
        blocked = this.entries.some((p) => p.form !== 'roof' && position.y >= memberBounds(p).y0 - 0.02 &&
          position.y <= memberBounds(p).y1 + 0.02 && containsXZ(p, x, z, 0.025));
      }
      if (blocked) walls++;
    }
    return coverage * (0.35 + 0.6 * walls / 8);
  }

  serialize() {
    return { version: 1, pieces: this.entries.map((entry) => memberRecord(entry)) };
  }

  restore(snapshot) {
    const records = validateHomestead(snapshot, { groundAt: this.groundAt, avoid: this.avoid });
    if (!records) return false;
    this.group.clear();
    this._entryByMesh = new WeakMap();
    this.entries.length = this.colliders.length = 0;
    this._nextId = 1;
    for (const record of records) {
      this._add(record);
      this._nextId = Math.max(this._nextId, record.id + 1);
    }
    return true;
  }

  dispose() {
    this.group.removeFromParent();
    for (const geometry of Object.values(this._geometry)) geometry.dispose();
    for (const material of Object.values(this._fallback)) material.dispose();
  }
}
