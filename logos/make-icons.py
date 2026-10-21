# Draws the PNG app icons from the wings polygons in logo.svg: opaque full-bleed
# squares (platforms round them), glyph at 86%, maskable at 76%. Run: python3 logos/make-icons.py .
import sys
from PIL import Image, ImageDraw
polys=[("244,150 76,118 76,196 244,236","#ffffff"),("244,262 100,238 100,306 244,334","#a5b4fc"),("244,360 138,346 138,404 244,420","#6366f1"),
("268,150 436,118 436,196 268,236","#ffffff"),("268,262 412,238 412,306 268,334","#a5b4fc"),("268,360 374,346 374,404 268,420","#6366f1")]
K=8; N=512*K
def draw(s):
    im=Image.new("RGB",(N,N),"#4f46e5"); d=ImageDraw.Draw(im)
    for pts,c in polys:
        p=[tuple(map(float,q.split(","))) for q in pts.split()]
        d.polygon([((256+(x-256)*s)*K,(256+(y-269)*s)*K) for x,y in p],fill=c)
    return im
root=sys.argv[1]
im=draw(0.86)

out={f"{root}/src/client/public/icon-512.png":512,f"{root}/src/client/public/icon-192.png":192,f"{root}/src/client/public/apple-touch-icon.png":180}
for n in (16,32,48,192,512,1024,2048): out[f"{root}/logos/export/logo-square-{n}.png"]=n
for path,n in out.items(): im.resize((n,n),Image.LANCZOS).save(path,optimize=True)
mk=draw(0.76); mk.resize((512,512),Image.LANCZOS).save(f"{root}/src/client/public/icon-maskable-512.png",optimize=True)
