import re
import urllib.request

url = "https://www.christtheking-school.com/"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
print("len", len(html))
for pat, label in [
    (r'(?:src|href)=["\']([^"\']+\.(?:png|jpg|jpeg|svg|webp)[^"\']*)', "asset"),
    (r'url\(([^)]+)\)', "cssurl"),
]:
    found = re.findall(pat, html, re.I)
    print(label, len(found))
    for m in found[:40]:
        print(" ", m[:200])
