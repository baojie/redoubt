/**
 * Logistics — PLAN §2.5. The loop that decides matches.
 */

import { describe, expect, it } from "vitest";
import { rules } from "../src/index.js";
import type { Command } from "../src/index.js";
import { eventsOfType, firstEvent, harness } from "./helpers.js";

/**
 * Open ground: clear of every hand-placed cover volume and far enough from
 * both main bases that a FOB may legally be planted here. Tests that are not
 * about cover should not accidentally be standing in a wall.
 */
const OPEN_GROUND = { x: 150, y: 150 };

function driverInTruck(h: ReturnType<typeof harness>) {
  const driver = h.team(0)[3]!;
  const truck = h.state.vehicles.find((v) => v.team === 0 && v.type === "logistics")!;
  h.place(driver.id, truck.pos);
  h.tick([{ t: "enterVehicle", player: driver.id, vehicle: truck.id }]);
  expect(driver.vehicle).toBe(truck.id);
  return { driver, truck };
}

/** Load a truck to capacity at main, returning everything that happened. */
function loadFull(h: ReturnType<typeof harness>, driverId: number) {
  const spec = rules.VEHICLE_SPECS.logistics;
  const load: Command = {
    t: "loadSupply",
    player: driverId,
    constructionPoints: spec.maxCargoConstructionPoints,
    ammoPoints: spec.maxCargoAmmoPoints,
  };
  return h.run(rules.secondsToTicks(60), () => [load]);
}

describe("loading", () => {
  it("only works at your own main base", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    truck.pos = { x: OPEN_GROUND.x, y: OPEN_GROUND.y };

    const events = h.tick([
      { t: "loadSupply", player: driver.id, constructionPoints: 100, ammoPoints: 0 },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("notAtMainBase");
  });

  it("only works stopped", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    truck.speedMps = rules.SUPPLY_TRANSFER_MAX_SPEED_MPS + 1;

    const events = h.tick([
      { t: "loadSupply", player: driver.id, constructionPoints: 100, ammoPoints: 0 },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("movingTooFast");
  });

  it("fills to the truck's capacity and no further", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    const spec = rules.VEHICLE_SPECS.logistics;

    loadFull(h, driver.id);

    expect(truck.cargoConstructionPoints).toBe(spec.maxCargoConstructionPoints);
    expect(truck.cargoAmmoPoints).toBe(spec.maxCargoAmmoPoints);
  });

  it("takes real time — supply is not teleported", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);

    h.tick([
      { t: "loadSupply", player: driver.id, constructionPoints: 1200, ammoPoints: 0 },
    ]);
    expect(truck.cargoConstructionPoints).toBe(rules.SUPPLY_TRANSFER_POINTS_PER_TICK);
    expect(truck.cargoConstructionPoints).toBeLessThan(1200);
  });

  it("reports one event for the whole run, not one per tick", () => {
    const h = harness();
    const { driver } = driverInTruck(h);
    // The load takes hundreds of ticks; the session is reported once, when it
    // stops, with the run total — otherwise the event log is unreadable.
    const events = loadFull(h, driver.id);

    const loads = eventsOfType(events, "supplyLoaded");
    expect(loads).toHaveLength(1);
    expect(loads[0]!.constructionPoints).toBe(
      rules.VEHICLE_SPECS.logistics.maxCargoConstructionPoints,
    );
    expect(loads[0]!.ammoPoints).toBe(rules.VEHICLE_SPECS.logistics.maxCargoAmmoPoints);
  });

  it("refuses to load an armoured vehicle", () => {
    const h = harness();
    const driver = h.team(0)[3]!;
    const apc = h.state.vehicles.find((v) => v.team === 0 && v.type === "armoured")!;
    h.place(driver.id, apc.pos);
    h.tick([{ t: "enterVehicle", player: driver.id, vehicle: apc.id }]);

    const events = h.tick([
      { t: "loadSupply", player: driver.id, constructionPoints: 100, ammoPoints: 0 },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("notALogisticsVehicle");
  });
});

describe("unloading", () => {
  it("delivers into a FOB inside the build radius", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;

    const { driver, truck } = driverInTruck(h);
    loadFull(h, driver.id);
    truck.pos = { x: fob.pos.x, y: fob.pos.y };
    truck.speedMps = 0;

    const delivered = truck.cargoConstructionPoints;
    h.run(rules.secondsToTicks(60), () => [
      {
        t: "unloadSupply",
        player: driver.id,
        fob: fob.id,
        constructionPoints: delivered,
        ammoPoints: 0,
      },
    ]);

    expect(fob.constructionPoints).toBe(delivered);
    expect(truck.cargoConstructionPoints).toBe(0);
  });

  it("refuses a FOB out of range", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;

    const { driver, truck } = driverInTruck(h);
    loadFull(h, driver.id);
    truck.pos = { x: fob.pos.x + rules.SUPPLY_UNLOAD_REACH_M + 1, y: fob.pos.y };
    truck.speedMps = 0;

    const events = h.tick([
      {
        t: "unloadSupply",
        player: driver.id,
        fob: fob.id,
        constructionPoints: 100,
        ammoPoints: 0,
      },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("fobOutOfReach");
  });

  it("never pushes a FOB past its supply ceiling", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;
    fob.constructionPoints = rules.FOB_MAX_CONSTRUCTION_POINTS;

    const { driver, truck } = driverInTruck(h);
    loadFull(h, driver.id);
    truck.pos = { x: fob.pos.x, y: fob.pos.y };
    truck.speedMps = 0;

    h.run(rules.secondsToTicks(30), () => [
      {
        t: "unloadSupply",
        player: driver.id,
        fob: fob.id,
        constructionPoints: 1000,
        ammoPoints: 0,
      },
    ]);

    expect(fob.constructionPoints).toBe(rules.FOB_MAX_CONSTRUCTION_POINTS);
    expect(truck.cargoConstructionPoints).toBeGreaterThan(0);
  });
});

describe("losing a vehicle", () => {
  it("protects its crew from small arms until it is wrecked", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    const health = driver.health;

    const shooter = h.team(1)[0]!;
    h.place(shooter.id, { x: truck.pos.x + 14, y: truck.pos.y });
    h.run(rules.secondsToTicks(8), () => [
      { t: "engage", player: shooter.id, target: driver.id },
    ]);

    expect(driver.health).toBe(health);
    expect(truck.health).toBeLessThan(rules.VEHICLE_SPECS.logistics.maxHealth);
  });

  it("costs the ticket, ejects the crew and burns the cargo", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    loadFull(h, driver.id);

    const before = h.state.teams[0].tickets;
    truck.health = 1;

    // Walk an enemy up and shoot it out.
    const shooter = h.team(1)[0]!;
    h.place(shooter.id, { x: truck.pos.x + 12, y: truck.pos.y });
    const events = h.run(rules.secondsToTicks(30), () => [
      { t: "look", player: shooter.id, yaw: Math.PI, pitch: 0 },
      { t: "fire", player: shooter.id },
    ]);

    expect(truck.destroyed).toBe(true);
    expect(firstEvent(events, "vehicleDestroyed")?.kind).toBe("logistics");
    // Charged against the vehicle specifically. The raw total also moves,
    // because the crew we just threw into the open tend not to survive — that
    // is the rule working, not a miscount.
    const charge = eventsOfType(events, "ticketChange").find(
      (e) => e.reason === "vehicleLost",
    );
    expect(charge?.delta).toBe(-rules.VEHICLE_SPECS.logistics.ticketCost);
    expect(h.state.teams[0].tickets).toBeLessThanOrEqual(
      before - rules.VEHICLE_SPECS.logistics.ticketCost,
    );
    // Crew is out, and the load is gone with it.
    expect(driver.vehicle).toBeNull();
    expect(truck.occupants).toHaveLength(0);
    expect(truck.cargoConstructionPoints).toBe(0);
  });

  it("shrugs small arms off armour far better than off a truck", () => {
    const logistics = rules.VEHICLE_SPECS.logistics.smallArmsResistance;
    const armoured = rules.VEHICLE_SPECS.armoured.smallArmsResistance;
    expect(armoured).toBeLessThan(logistics / 5);
  });

  it("comes back at main after its respawn timer", () => {
    const h = harness();
    const truck = h.state.vehicles.find((v) => v.team === 0 && v.type === "logistics")!;
    truck.destroyed = true;
    truck.health = 0;
    truck.pos = { x: 500, y: 500 };
    truck.respawnAtTick = h.state.tick + 5;

    h.run(10);

    expect(truck.destroyed).toBe(false);
    expect(truck.health).toBe(rules.VEHICLE_SPECS.logistics.maxHealth);
    // Its own bay, not the shared spawn point — otherwise the fleet stacks.
    expect(truck.pos).toEqual({ x: truck.homeX, y: truck.homeY });
  });

  it("stops rounds, so parking across a street is cover", () => {
    const h = harness();
    const truck = h.state.vehicles.find((v) => v.team === 0 && v.type === "logistics")!;
    truck.pos = { x: OPEN_GROUND.x, y: OPEN_GROUND.y };

    // Shooter and target on opposite sides of the truck, in line with it.
    const shooter = h.team(1)[0]!;
    const victim = h.team(0)[5]!;
    h.place(shooter.id, { x: OPEN_GROUND.x - 20, y: OPEN_GROUND.y });
    h.place(victim.id, { x: OPEN_GROUND.x + 20, y: OPEN_GROUND.y });
    const health = victim.health;

    // Short enough that the truck survives: once it is wrecked it stops being
    // cover, which is itself the correct behaviour and not what this measures.
    h.run(rules.secondsToTicks(8), () => [
      { t: "engage", player: shooter.id, target: victim.id },
    ]);

    // The truck ate every round. It is worse for wear; the soldier is not.
    expect(truck.destroyed).toBe(false);
    expect(victim.health).toBe(health);
    expect(truck.health).toBeLessThan(rules.VEHICLE_SPECS.logistics.maxHealth);
  });
});

describe("the motor pool", () => {
  it("parks every vehicle in its own space, so hulls do not overlap", () => {
    const h = harness();
    const fleet = h.state.vehicles.filter((v) => v.team === 0);
    expect(fleet.length).toBeGreaterThan(1);

    for (let i = 0; i < fleet.length; i++) {
      for (let j = i + 1; j < fleet.length; j++) {
        const a = fleet[i]!;
        const b = fleet[j]!;
        const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        const clearance =
          Math.max(
            rules.VEHICLE_SPECS[a.type].halfLengthM,
            rules.VEHICLE_SPECS[b.type].halfLengthM,
          ) * 2;
        expect(gap, `${a.type} and ${b.type} overlap at spawn`).toBeGreaterThan(
          clearance * 0.9,
        );
      }
    }
  });

  it("mirrors the two motor pools", () => {
    const h = harness();
    const blue = h.state.vehicles.filter((v) => v.team === 0);
    const red = h.state.vehicles.filter((v) => v.team === 1);
    expect(blue.length).toBe(red.length);
    for (let i = 0; i < blue.length; i++) {
      // Same arrangement, reflected: neither side has a shorter walk to a truck.
      expect(blue[i]!.pos.y).toBeCloseTo(red[i]!.pos.y, 6);
      expect(h.state.map.sizeM - blue[i]!.pos.x).toBeCloseTo(red[i]!.pos.x, 6);
    }
  });
});

describe("repair stations", () => {
  it("mend a parked vehicle, paid for out of the FOB", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;
    fob.constructionPoints = rules.FOB_MAX_CONSTRUCTION_POINTS;

    h.tick([
      {
        t: "placeDeployable",
        player: team[0]!.id,
        fob: fob.id,
        kind: "repairStation",
        pos: OPEN_GROUND,
      },
    ]);
    const station = h.state.deployables[0]!;
    h.run(rules.secondsToTicks(rules.DEPLOYABLE_SPECS.repairStation.buildWorkSeconds) + 2, () => [
      { t: "build", player: team[0]!.id, deployable: station.id },
    ]);
    expect(station.built).toBe(true);

    const truck = h.state.vehicles.find((v) => v.team === 0 && v.type === "logistics")!;
    truck.pos = { x: OPEN_GROUND.x + 2, y: OPEN_GROUND.y };
    truck.health = 100;
    const supplyBefore = fob.constructionPoints;

    h.run(rules.secondsToTicks(6));

    expect(truck.health).toBeGreaterThan(100);
    // Repairs are not free — that is why the station lives on a FOB.
    expect(fob.constructionPoints).toBeLessThan(supplyBefore);
  });

  it("will not repair the enemy's vehicles", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;
    fob.constructionPoints = rules.FOB_MAX_CONSTRUCTION_POINTS;
    h.tick([
      {
        t: "placeDeployable",
        player: team[0]!.id,
        fob: fob.id,
        kind: "repairStation",
        pos: OPEN_GROUND,
      },
    ]);
    const station = h.state.deployables[0]!;
    h.run(rules.secondsToTicks(rules.DEPLOYABLE_SPECS.repairStation.buildWorkSeconds) + 2, () => [
      { t: "build", player: team[0]!.id, deployable: station.id },
    ]);

    const enemyTruck = h.state.vehicles.find((v) => v.team === 1)!;
    enemyTruck.pos = { x: OPEN_GROUND.x + 2, y: OPEN_GROUND.y };
    enemyTruck.health = 100;

    h.run(rules.secondsToTicks(6));
    expect(enemyTruck.health).toBe(100);
  });
});

describe("driving", () => {
  it("only the driver's seat steers", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    const passenger = h.team(0)[4]!;
    h.place(passenger.id, truck.pos);
    h.tick([{ t: "enterVehicle", player: passenger.id, vehicle: truck.id }]);

    const events = h.tick([
      { t: "driveTo", player: passenger.id, to: OPEN_GROUND },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("notDriver");

    h.tick([{ t: "driveTo", player: driver.id, to: OPEN_GROUND }]);
    expect(truck.waypoint).toEqual(OPEN_GROUND);
  });

  it("carries its occupants along", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    h.tick([{ t: "driveTo", player: driver.id, to: OPEN_GROUND }]);
    h.run(rules.secondsToTicks(5));

    expect(truck.pos.x).toBeGreaterThan(h.state.teams[0].mainBase.x);
    expect(driver.pos).toEqual(truck.pos);
  });

  it("takes throttle and wheel directly, for a human at the controls", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    truck.pos = { x: OPEN_GROUND.x, y: OPEN_GROUND.y };
    truck.heading = 0;
    const start = { ...truck.pos };

    h.tick([{ t: "drive", player: driver.id, throttle: 1, steering: 0 }]);
    h.run(rules.secondsToTicks(3));

    expect(truck.pos.x).toBeGreaterThan(start.x + 10);
    expect(truck.pos.y).toBeCloseTo(start.y, 3);
  });

  it("cannot pirouette on the spot — turning needs rolling", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    truck.heading = 0;

    h.tick([{ t: "drive", player: driver.id, throttle: 0, steering: 1 }]);
    h.run(rules.secondsToTicks(3));

    expect(truck.heading).toBeCloseTo(0, 6);
    expect(truck.speedMps).toBe(0);
  });

  it("clamps the throttle, so a bigger number is not a faster truck", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    truck.pos = { x: OPEN_GROUND.x, y: OPEN_GROUND.y };
    truck.heading = 0;
    const start = truck.pos.x;

    h.tick([{ t: "drive", player: driver.id, throttle: 50, steering: 0 }]);
    h.run(rules.secondsToTicks(2));

    // Two seconds at top speed, give or take the tick the order arrived on.
    const travelled = truck.pos.x - start;
    const expected = rules.VEHICLE_SPECS.logistics.speedMps * 2;
    expect(travelled).toBeGreaterThan(expected - 1);
    expect(travelled).toBeLessThan(expected + 1);
  });

  it("hands the wheel from a bot's waypoint to a human without a fight", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    h.tick([{ t: "driveTo", player: driver.id, to: { x: 400, y: 400 } }]);
    expect(truck.waypoint).not.toBeNull();

    h.tick([{ t: "drive", player: driver.id, throttle: 1, steering: 0 }]);
    expect(truck.waypoint).toBeNull();
  });

  it("halting the driver stops the truck, not just their legs", () => {
    const h = harness();
    const { driver, truck } = driverInTruck(h);
    h.tick([{ t: "driveTo", player: driver.id, to: OPEN_GROUND }]);
    h.run(rules.secondsToTicks(2));
    expect(truck.speedMps).toBeGreaterThan(0);

    h.tick([{ t: "halt", player: driver.id }]);
    h.run(2);

    expect(truck.waypoint).toBeNull();
    expect(truck.speedMps).toBe(0);
    expect(truck.throttle).toBe(0);
  });

  it("respects seat count", () => {
    const h = harness();
    const { truck } = driverInTruck(h);
    const seats = rules.VEHICLE_SPECS.logistics.seats;
    const spare = h.team(0).filter((p) => p.vehicle === null);

    for (let i = 0; i < seats - 1; i++) {
      const p = spare[i]!;
      h.place(p.id, truck.pos);
      h.tick([{ t: "enterVehicle", player: p.id, vehicle: truck.id }]);
    }
    expect(truck.occupants).toHaveLength(seats);

    const extra = spare[seats]!;
    h.place(extra.id, truck.pos);
    const events = h.tick([{ t: "enterVehicle", player: extra.id, vehicle: truck.id }]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("vehicleFull");
  });
});
