// Paste into the devtools console of a logged-in https://danbooru.donmai.us tab.
// Crawls the tag_groups wiki hub and every tag_group:* page it links, 1 request
// per second, then downloads tag_group_pages.json ({title: dtext}) for
// `build_tag_groups.py --pages-json`.
(async () => {
  const norm = (t) => t.trim().toLowerCase().replace(/\s+/g, "_");
  const links = (body) => {
    const out = new Set();
    for (const m of body.matchAll(/\[\[\s*(tag[ _]group:[^\]|#]+)/gi)) out.add(norm(m[1]));
    for (const m of body.matchAll(/\/wiki_pages\/(tag_group(?::|%3A)[^\s\])"]+)/gi))
      out.add(norm(decodeURIComponent(m[1])));
    return [...out];
  };
  const pages = {};
  const queue = ["tag_groups"];
  while (queue.length) {
    const title = queue.shift();
    if (title in pages) continue;
    const r = await fetch(`/wiki_pages.json?search[title]=${encodeURIComponent(title)}&only=title,body&limit=1`);
    if (!r.ok) { console.error(title, r.status); pages[title] = null; continue; }
    const [page] = await r.json();
    pages[title] = page ? page.body : null;
    console.log(title, page ? "ok" : "missing");
    if (page) queue.push(...links(page.body));
    await new Promise((res) => setTimeout(res, 1000));
  }
  const clean = Object.fromEntries(Object.entries(pages).filter(([, b]) => b !== null));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(clean)], { type: "application/json" }));
  a.download = "tag_group_pages.json";
  a.click();
  console.log("done:", Object.keys(clean).length, "pages");
})();
