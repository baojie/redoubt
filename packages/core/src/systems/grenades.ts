/**
 * Grenades: the answer to something you cannot shoot.
 *
 * A soldier carries three. Rifles resolve as an instant segment — see
 * ballistics.ts — but a grenade is the one thing in the game that takes time to
 * arrive, and that is the whole point of it: it is thrown at where somebody
 * will be, or at a place rather than a person, and the three and a half seconds
 * between the throw and the blast are time the defender can use.
 *
 * Simulated as a point on a ballistic arc, integrated once per tick. No
 * rotation, no bounce physics: what matters to the rules is where it is when
 * the fuse runs out, and a tumbling model would cost determinism and buy
 * nothing the player can act on.
 *
 * Everything here is deterministic — fixed timestep, no randomness, no clock.
 */

import { distance3, type Vec3 } from "../math.js";
import {
  GRAVITY_MPS2,
  GRENADE_BLAST_RADIUS_M,
  GRENADE_COVER_DAMAGE_FRACTION,
  GRENADE_FUSE_TICKS,
  GRENADE_LETHAL_RADIUS_M,
  GRENADE_MAX_DAMAGE,
  GRENADE_SUPPRESSION,
  GRENADE_THROW_PITCH_RAD,
  GRENADE_THROW_SPEED_MPS,
  EYE_HEIGHT_M,
  TICK_RATE_HZ,
  TORSO_HEIGHT_M,
} from "../rules.js";
import { segmentHitsBox, type CoverBox } from "../cover.js";
import type { Player } from "../types.js";
import type { World } from "../world.js";

/** Throw one, if the soldier has one to throw and a hand free to do it. */
export type ThrowRejection = "notAlive" | "mounted" | "noGrenades";

export function throwGrenade(world: World, thrower: Player): ThrowRejection | null {
  if (thrower.status !== "alive") return "notAlive";
  // Both hands are on the wheel. Leaning out of a truck to lob one is a real
  // thing soldiers do and a thing this game does not model.
  if (thrower.vehicle !== null) return "mounted";
  if (thrower.grenades <= 0) return "noGrenades";

  thrower.grenades--;

  const state = world.state;
  const groundZ = world.terrain.heightAt(thrower.pos.x, thrower.pos.y);
  // Thrown from the eye, along the aim, but lofted: a grenade thrown flat at
  // the thing you are looking at lands short of it every time.
  const pitch = thrower.aimPitch + GRENADE_THROW_PITCH_RAD;
  const horizontal = Math.cos(pitch) * GRENADE_THROW_SPEED_MPS;

  const grenade = {
    id: state.nextEntityId++,
    thrower: thrower.id,
    team: thrower.team,
    pos: {
      x: thrower.pos.x,
      y: thrower.pos.y,
      z: groundZ + EYE_HEIGHT_M,
    },
    velocity: {
      x: Math.cos(thrower.aimYaw) * horizontal,
      y: Math.sin(thrower.aimYaw) * horizontal,
      z: Math.sin(pitch) * GRENADE_THROW_SPEED_MPS,
    },
    fuseAtTick: state.tick + GRENADE_FUSE_TICKS,
  };
  state.grenades.push(grenade);

  world.emit({
    t: "grenadeThrown",
    grenade: grenade.id,
    thrower: thrower.id,
    team: thrower.team,
    from: { ...grenade.pos },
  });
  return null;
}

/**
 * Fly every grenade one tick, and detonate the ones whose fuse has run out.
 *
 * Damage is applied here but casualties are not resolved: like gunfire, that
 * waits for the end of the tick, so a grenade that kills two people who were
 * also shooting each other resolves in one consistent order.
 */
export function updateGrenades(world: World): void {
  const state = world.state;
  const step = 1 / TICK_RATE_HZ;

  for (let i = state.grenades.length - 1; i >= 0; i--) {
    const grenade = state.grenades[i]!;

    grenade.velocity.z -= GRAVITY_MPS2 * step;
    grenade.pos.x += grenade.velocity.x * step;
    grenade.pos.y += grenade.velocity.y * step;
    grenade.pos.z += grenade.velocity.z * step;

    // The ground stops it. It keeps its fuse and sits there, which is what
    // makes a grenade rolled into a room different from one thrown at a wall.
    const groundZ = world.terrain.heightAt(grenade.pos.x, grenade.pos.y);
    if (grenade.pos.z <= groundZ) {
      grenade.pos.z = groundZ;
      grenade.velocity.x = 0;
      grenade.velocity.y = 0;
      grenade.velocity.z = 0;
    }

    if (state.tick < grenade.fuseAtTick) continue;

    detonate(world, grenade);
    state.grenades.splice(i, 1);
  }
}

function detonate(world: World, grenade: World["state"]["grenades"][number]): void {
  world.emit({
    t: "grenadeExploded",
    grenade: grenade.id,
    thrower: grenade.thrower,
    at: { ...grenade.pos },
  });

  const boxes: CoverBox[] = [];
  world.coverGrid.near(grenade.pos.x, grenade.pos.y, GRENADE_BLAST_RADIUS_M, boxes);

  for (const victim of world.state.players) {
    if (victim.status === "deploying") continue;
    // Inside a hull is inside a hull. The same rule small arms follow.
    if (victim.vehicle !== null) continue;

    const groundZ = world.terrain.heightAt(victim.pos.x, victim.pos.y);
    const centre: Vec3 = {
      x: victim.pos.x,
      y: victim.pos.y,
      z: groundZ + TORSO_HEIGHT_M,
    };
    const range = distance3(grenade.pos, centre);
    if (range > GRENADE_BLAST_RADIUS_M) continue;

    // Falloff between the two radii: everything inside the lethal radius takes
    // the full charge, and it fades to nothing at the edge.
    const falloff =
      range <= GRENADE_LETHAL_RADIUS_M
        ? 1
        : 1 -
          (range - GRENADE_LETHAL_RADIUS_M) /
            (GRENADE_BLAST_RADIUS_M - GRENADE_LETHAL_RADIUS_M);

    const sheltered = blocked(grenade.pos, centre, boxes);
    const share = sheltered ? GRENADE_COVER_DAMAGE_FRACTION : 1;

    // Suppression lands on everybody nearby, friend or foe, sheltered or not:
    // being close to a blast is disorienting whoever threw it. Deferred like
    // gunfire's, so simultaneous blasts do not depend on iteration order.
    victim.pendingSuppression += GRENADE_SUPPRESSION * falloff;

    // Friendly fire is not modelled for damage — the bots would kill their own
    // squad constantly and the ticket economy would stop measuring anything —
    // but the noise and the shock above still reach them.
    if (victim.team === grenade.team) continue;
    if (victim.invulnerable) continue;
    if (victim.status !== "alive" && victim.status !== "downed") continue;

    victim.health -= GRENADE_MAX_DAMAGE * falloff * share;
    victim.lastHitBy = grenade.thrower;
  }
}

/** Is there a wall between the blast and the body? */
function blocked(from: Vec3, to: Vec3, boxes: readonly CoverBox[]): boolean {
  for (const box of boxes) {
    if (segmentHitsBox(from, to, box) !== null) return true;
  }
  return false;
}
