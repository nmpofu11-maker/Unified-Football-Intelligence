import test from "node:test";
import assert from "node:assert/strict";
import teamSeed from "../src/data/initial-tracked-teams.json" with { type: "json" };

test("authoritative favourite watchlist contains exactly the 80 user-ordered teams", () => {
  const expectedNames = [
    "St Patrick's Athletic", "Shelbourne Women", "Linfield Women", "Sligo Rovers Women", "St Johnstone F.C.",
    "Club Brugge", "FC Nantes", "RC Sporting Charleroi", "Benfica U19", "Ahlafors IF",
    "Vorup FB", "Haugesund B", "Riga FC", "FC Flora Tallinn", "Viimsi JK",
    "Rigas Futbola Skola", "Tvaakers IF", "Rosenborg BK Women", "BK Forward", "Smedby AIS",
    "Qviding FIF", "Ekenas IF Fotbolll", "Gnistan Helsinki", "MSK Zilina", "ZNK Agram (w)",
    "Saldus SS/Leevon", "FK Rostov Youth", "Dinamo Zagreb", "FC Nomme United", "FC Iberia 1999 Tbilisi",
    "Rijeka", "Poland Women", "Tabor Sezana", "FC Gomel", "Slovan Ljubljana",
    "Fotbal Club FCSB", "FK Mladost DG", "FC Pyunik", "Almaz Antey Youth", "BE1 NFA",
    "Dnepr Mogilev", "Wolfsberger AC Amateure", "Inter Milan Women", "Napoli", "Fram Reykjavik",
    "FC Noah", "Taftea IK", "FC Dinamo City", "KF Laci", "Stenungsunds IF",
    "Bolivar", "Real Cartagena", "Nacional De Football Women", "Atletico Nacional Medellin (W)", "Peru Women",
    "Penarol Reserve", "Uruguay", "Boston River Reserve", "France U16", "Madura United FC",
    "Japan U16", "Truong Tuoi Dong Nai", "FC Ulaanbaatar", "Qingdao Team", "PVF-CAND FC",
    "Beijing Guoan", "Mohun Bagan Super Giant", "Shanghai Shenhua", "Shanghai Port", "Johor Darul Ta'zim FC",
    "Hunters FC", "Pattani", "MC Oran", "Tabora United FC", "Azam FC",
    "Como 1907", "Nykoebing FC", "VSK Aarhus", "Domagnano", "SP Tre Penne"
  ];
  assert.equal(teamSeed.count, 80);
  assert.equal(teamSeed.teams.length, 80);
  assert.deepEqual(teamSeed.teams.map(team => team.canonicalName), expectedNames);
  assert.equal(new Set(teamSeed.teams.map(team => team.id)).size, 80);
  assert.ok(teamSeed.teams.every(team => team.country.trim() && team.league.trim()));
  assert.ok(teamSeed.teams.every(team => ["senior", "women", "youth", "reserve", "international", "international_women", "international_youth"].includes(team.teamCategory)));
});

test("watchlist retains women's, youth, reserve and international distinctions", () => {
  const categoryByName = new Map(teamSeed.teams.map(team => [team.canonicalName, team.teamCategory]));
  for (const name of ["Shelbourne Women", "Linfield Women", "Sligo Rovers Women", "Rosenborg BK Women", "ZNK Agram (w)", "Inter Milan Women", "Nacional De Football Women", "Atletico Nacional Medellin (W)"]) {
    assert.equal(categoryByName.get(name), "women", name);
  }
  for (const name of ["Benfica U19", "FK Rostov Youth", "Almaz Antey Youth"]) assert.equal(categoryByName.get(name), "youth", name);
  for (const name of ["Haugesund B", "Wolfsberger AC Amateure", "Penarol Reserve", "Boston River Reserve"]) assert.equal(categoryByName.get(name), "reserve", name);
  assert.equal(categoryByName.get("Poland Women"), "international_women");
  assert.equal(categoryByName.get("Peru Women"), "international_women");
  assert.equal(categoryByName.get("France U16"), "international_youth");
  assert.equal(categoryByName.get("Japan U16"), "international_youth");
  assert.equal(categoryByName.get("Uruguay"), "international");
});

test("watchlist metadata does not imply provider mapping or verified history", () => {
  assert.ok(teamSeed.teams.every(team => team.mappingState === "unresolved"));
  assert.ok(teamSeed.teams.every(team => Object.keys(team.providerIds).length === 0));
  assert.ok(teamSeed.teams.every(team => team.aliases.length === 0));
});
