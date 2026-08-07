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
