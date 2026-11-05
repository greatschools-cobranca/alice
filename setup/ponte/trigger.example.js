// Modelo; o instalador fixa ID e SHA-256 da rotina. Nunca inserir chave no script.
// Requer cron.triggers.enabled e o exec nativo permitido para esta rotina.
// Usa o catálogo já autorizado; não faz chamada de modelo.
const response = await exec({
  command: "python3 -I /data/.config/torre-de-controle/gate.py ROTINA_ID VERSAO_SHA256",
  timeout: 10,
  yieldMs: 10000,
});
const lines = (response.content || []).filter(c => c.type === "text").flatMap(c => String(c.text).split("\n"));
let fire = false;
for (const line of lines) {
  try {
    const value = JSON.parse(line);
    if (value.torre_gate === "v2" && value.fire === true) fire = true;
  } catch {}
}
return { fire };
