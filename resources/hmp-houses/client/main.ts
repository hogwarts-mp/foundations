// The Framework currently applies one resource-dependency graph on both server and client.
// hmp-houses has no client API, but this entry keeps it present so client-bearing dependents,
// such as gamemodes built on house membership, can satisfy the same manifest graph.
console.info("[hmp-houses] client dependency shim ready");
