// The Framework currently applies one resource-dependency graph on both server and client.
// hmp-jobs has no client API, but this entry keeps it present so client-bearing dependents
// can satisfy the same manifest graph.
console.info("[hmp-jobs] client dependency shim ready");
