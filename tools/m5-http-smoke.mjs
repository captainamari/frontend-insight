const checks = [
  ["api", "http://127.0.0.1:3000/health/ready"],
  ["management UI", "http://web:8080/health"],
  ["demo app", "http://demo:8080/health"],
];

for (const [name, url] of checks) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} smoke failed: ${response.status}`);
  }
}

console.log(JSON.stringify({ status: "passed", checks: checks.map(([name]) => name) }));
