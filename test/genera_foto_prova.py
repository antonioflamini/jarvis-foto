"""Genera un set di foto e video di prova realistico per collaudare JARVIS Foto.
Uso: python test/genera_foto_prova.py <cartella_destinazione>
"""
import os, sys, random, shutil, subprocess, zipfile, time
from datetime import datetime, timedelta
from PIL import Image, ImageDraw
from PIL.TiffImagePlugin import IFDRational as R
import json

random.seed(7)
dest = sys.argv[1] if len(sys.argv) > 1 else 'foto_prova'
shutil.rmtree(dest, ignore_errors=True)
os.makedirs(dest)

def immagine(percorso, quando=None, marca=None, modello=None, fmt='JPEG', gps=None, scala=1.0, seme=None):
    if seme is not None: random.seed(seme)
    w, h = 960, 640
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    c1 = [random.randint(0, 255) for _ in range(3)]
    c2 = [random.randint(0, 255) for _ in range(3)]
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    for _ in range(6):
        x, y, r = random.randint(0, w), random.randint(0, h), random.randint(30, 160)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(random.randint(0, 255) for _ in range(3)))
    d.text((20, 20), os.path.basename(percorso), fill=(255, 255, 255))
    os.makedirs(os.path.dirname(percorso), exist_ok=True)
    if fmt == 'JPEG':
        exif = img.getexif()
        if marca: exif[0x010F] = marca
        if modello: exif[0x0110] = modello
        if quando:
            exif.get_ifd(0x8769)[0x9003] = quando.strftime('%Y:%m:%d %H:%M:%S')
        if gps:
            g = exif.get_ifd(0x8825)
            def gms(v):
                a = abs(v); d = int(a); m = int((a - d) * 60); return (R(d), R(m), R(round(((a - d) * 60 - m) * 60, 2)))
            g[1] = 'N' if gps[0] >= 0 else 'S'; g[2] = gms(gps[0]); g[3] = 'E' if gps[1] >= 0 else 'W'; g[4] = gms(gps[1])
        if scala != 1.0:
            img = img.resize((int(w * scala), int(h * scala)))
        img.save(percorso, 'JPEG', quality=85, exif=exif.tobytes())
    else:
        img.save(percorso, fmt)

base = datetime(2025, 8, 14, 16, 0, 0)
# 1) Festa: 30 foto nello stesso giorno (iPhone) -> cartella "giornata"
for i in range(30):
    q = base + timedelta(minutes=i * 7, seconds=random.randint(0, 50))
    immagine(f'{dest}/DCIM/100APPLE/IMG_{4100 + i}.JPG', q, 'Apple', 'iPhone 15 Pro', gps=(40.8953, 12.9589), seme=1000 + i)
# due scatti a raffica nello stesso secondo
q = datetime(2025, 8, 14, 21, 30, 15)
immagine(f'{dest}/DCIM/100APPLE/IMG_4200.JPG', q, 'Apple', 'iPhone 15 Pro')
immagine(f'{dest}/DCIM/100APPLE/IMG_4201.JPG', q, 'Apple', 'iPhone 15 Pro')
# 2) Foto sparse negli anni (Samsung, Canon)
for i in range(24):
    q = datetime(2022, 1, 1) + timedelta(days=random.randint(0, 1700), hours=random.randint(8, 20), minutes=random.randint(0, 59))
    if i % 3 == 0:
        immagine(f'{dest}/Camera/DSC_{1000 + i}.JPG', q, 'Canon', 'Canon EOS 250D')
    else:
        immagine(f'{dest}/Camera/{q.strftime("%Y%m%d_%H%M%S")}.jpg', q, 'samsung', 'SM-S918B')
# 3) WhatsApp senza EXIF, data solo nel nome
for i in range(5):
    immagine(f'{dest}/WhatsApp Images/IMG-2024031{i}-WA000{i}.jpg')
# 4) Screenshot
for i in range(3):
    immagine(f'{dest}/Screenshots/Screenshot_2025010{i + 1}-10101{i}.png', fmt='PNG')
# 5) Doppioni (stesse foto, nomi diversi)
shutil.copy(f'{dest}/DCIM/100APPLE/IMG_4105.JPG', f'{dest}/copia di IMG_4105.JPG')
shutil.copy(f'{dest}/Camera/DSC_1000.JPG', f'{dest}/Camera/DSC_1000 (1).JPG')
# 6) Foto senza alcuna data (solo data del file)
for i in range(2):
    p = f'{dest}/varie/immagine_scaricata_{i}.png'
    immagine(p, fmt='PNG')
    t = time.mktime(datetime(2023, 5, 20 + i, 12, 0).timetuple())
    os.utime(p, (t, t))
# 7) Video con data di creazione
for i, q in enumerate([datetime(2025, 8, 14, 18, 3, 0), datetime(2024, 12, 25, 11, 40, 0)]):
    p = f'{dest}/DCIM/100APPLE/IMG_{4300 + i}.MOV'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc=duration=1:size=320x240:rate=10',
                    '-metadata', f'creation_time={q.strftime("%Y-%m-%dT%H:%M:%S")}Z', '-pix_fmt', 'yuv420p', p], check=True)
# 7b) Copie ridotte (come da WhatsApp) di due foto della festa -> "Da scegliere"
for k in (3, 9):
    immagine(f'{dest}/WhatsApp Images/IMG-20250814-WA00{k:02d}.jpg', scala=0.5, seme=1000 + k)
# 7c) Live Photo: foto + video con lo stesso nome
q = datetime(2024, 4, 20, 17, 45, 0)
immagine(f'{dest}/DCIM/101APPLE/IMG_5001.JPG', q, 'Apple', 'iPhone 15 Pro', gps=(41.9028, 12.4964))
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
                '-metadata', f'creation_time={(q - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")}Z', '-pix_fmt', 'yuv420p', f'{dest}/DCIM/101APPLE/IMG_5001.MOV'], check=True)
# 7d) Esportazione Google Foto (Takeout): data nel file .json
os.makedirs(f'{dest}/Takeout/Google Foto/Foto del 2021', exist_ok=True)
for i in range(3):
    p = f'{dest}/Takeout/Google Foto/Foto del 2021/IMG_77{i}.jpg'
    immagine(p)
    ts = int(datetime(2021, 6, 12 + i, 11, 0).timestamp())
    json.dump({'title': os.path.basename(p), 'photoTakenTime': {'timestamp': str(ts)}, 'geoData': {'latitude': 43.7696, 'longitude': 11.2558}},
              open(p + '.supplemental-metadata.json', 'w'))
# 8) Uno zip (con uno zip annidato) di vacanze 2023
tmp = f'{dest}/_zip_tmp'
for i in range(10):
    q = datetime(2023, 7, 3, 9, 0) + timedelta(hours=i * 5)
    immagine(f'{tmp}/Vacanze/P{7000 + i}.jpg', q, 'Google', 'Pixel 7')
for i in range(3):
    q = datetime(2023, 7, 6, 9, 0) + timedelta(hours=i)
    immagine(f'{tmp}/annidato/P{8000 + i}.jpg', q, 'Google', 'Pixel 7')
with zipfile.ZipFile(f'{tmp}/annidato.zip', 'w') as z:
    for n in os.listdir(f'{tmp}/annidato'):
        z.write(f'{tmp}/annidato/{n}', f'altre/{n}')
os.makedirs(f'{dest}/zip', exist_ok=True)
with zipfile.ZipFile(f'{dest}/zip/Vacanze_2023.zip', 'w') as z:
    for n in os.listdir(f'{tmp}/Vacanze'):
        z.write(f'{tmp}/Vacanze/{n}', f'Vacanze/{n}')
    z.write(f'{tmp}/annidato.zip', 'annidato.zip')
shutil.rmtree(tmp)
# file da ignorare
open(f'{dest}/note.txt', 'w').write('non sono una foto')
print('Creato set di prova in', dest)
