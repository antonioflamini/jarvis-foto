# Installare JARVIS Foto sul PC, passando da GitHub

Alla fine JARVIS gira **da solo sul tuo PC Windows**: parte con il computer, resta in ascolto e lavora
senza Claude e senza internet. GitHub serve solo a custodire il programma e a distribuirne le versioni.

Tempo: circa 15 minuti, una volta sola.

---

## Parte A · Mettere il progetto su GitHub (dal browser)

**A1. Crea il repository**
1. Vai su <https://github.com/new> (accedi con il tuo account `antonioflamini`).
2. *Repository name*: `jarvis-foto`
3. Scegli **Public**. Serve per l'installazione con un solo comando. Nel repository c'è solo il programma:
   le tue foto non ci finiscono mai.
4. **Non** spuntare "Add a README", ".gitignore" o "license": il repository deve nascere vuoto.
5. Premi **Create repository**.

**A2. Carica i file**
1. Estrai `jarvis-foto-sorgente.zip` sul PC: ottieni una cartella `jarvis-foto`.
2. Nella pagina del repository appena creato clicca il link **uploading an existing file**.
3. Apri la cartella `jarvis-foto`, seleziona **tutto il contenuto** (Ctrl+A: anche le cartelle `.github`,
   `src`, `docs`, `strumenti`, `test` e i file `.gitignore`, `.gitattributes`) e trascinalo nella pagina.
   Va trascinato il contenuto della cartella, non la cartella `jarvis-foto` stessa.
4. In basso scrivi "Prima versione" e premi **Commit changes**.
5. Controlla che nella pagina del repository compaia la cartella **`.github`**. Se manca, ripeti il
   trascinamento solo per la cartella `.github`.

**A3. Controlla il collaudo automatico**
1. Apri la scheda **Actions** del repository.
2. Dopo un paio di minuti "Collaudo e rilascio" deve diventare verde ✔ (prove su Windows, Linux e Mac).
   Se GitHub chiede di abilitare le Actions, premi il pulsante verde per abilitarle.

**A4. Pubblica la prima Release**
1. Nella pagina del repository, a destra, clicca **Releases** → **Create a new release**
   (oppure vai su `https://github.com/antonioflamini/jarvis-foto/releases/new`).
2. **Choose a tag** → scrivi `v1.2.0` → **Create new tag: v1.2.0 on publish**.
3. *Release title*: `JARVIS Foto 1.2.0`
4. Premi **Publish release**.
5. Aspetta 3-4 minuti (scheda **Actions**: "pacchetto-windows" diventa verde).
   Poi, nella pagina della Release, sotto **Assets** devono comparire:
   - `JARVIS-Foto-Windows.zip`, il programma con Node.js incluso
   - `jarvis-foto.mcpb`, l'estensione facoltativa per Claude Desktop

---

## Parte B · Installare sul PC

**B1.** Premi Start, scrivi **PowerShell** e apri **Windows PowerShell**. Non serve aprirlo come amministratore.

**B2.** Incolla questo comando e premi Invio:

```powershell
irm https://raw.githubusercontent.com/antonioflamini/jarvis-foto/main/installa.ps1 | iex
```

**B3.** Rispondi alle tre domande. Premendo Invio accetti il valore proposto:
- come ti chiami
- dove mettere l'archivio (di base `Immagini\JARVIS_Foto`)
- la lettera del disco esterno per il backup (es. `F`), oppure Invio per decidere dopo

**B4.** Alla fine leggi **INSTALLAZIONE COMPLETATA** e **Sentinella attiva**. Sul desktop trovi:
- **JARVIS Foto**: il menu (backup, verifica, annulla, diagnostica…)
- **JARVIS Arrivi**: la cartella dove copiare foto, cartelle e zip
- **JARVIS Pannello**: il pannello olografico

> Se il repository è privato il comando non funziona. In quel caso scarica a mano `JARVIS-Foto-Windows.zip`
> dalla pagina della Release, estrailo e fai doppio clic su **`installa.bat`**: il risultato è lo stesso.

---

## Parte C · Provare che funzioni

1. **Diagnostica**: doppio clic su *JARVIS Foto* → tasto **D**. Controlla `scritturaArchivio: ok`,
   `voceItaliana: ok` e `sentinella: …attiva…`.
2. **Arrivi**: copia qualche foto nella cartella *JARVIS Arrivi* e aspetta una decina di secondi.
   Compare la finestra *"Nella cartella Arrivi ci sono N nuovi file. Li sistemo?"* → **Sì**.
   Si apre il pannello e le foto finiscono in ordine nell'archivio.
3. **Scheda SD o chiavetta**: inseriscila. Compare *"Ho trovato N foto e video su E:… Vuoi importarli?"*.
4. **Backup**: collega il disco esterno → menu *JARVIS Foto* → **3**.
5. **Riavvia il PC**: la sentinella riparte da sola (icona "JARVIS Sentinella" in
   `shell:startup`).

---

## Uso di tutti i giorni

| Voglio… | Faccio… |
|---|---|
| importare dalla scheda SD / chiavetta | la inserisco e rispondo **Sì** |
| importare dal telefono (cavo USB) | copio la cartella `DCIM` del telefono in **JARVIS Arrivi** e rispondo **Sì** |
| importare uno zip o un'esportazione Google Foto | lo copio in **JARVIS Arrivi** |
| fare il backup | collego il disco: se serve, JARVIS chiede se aggiornarlo |
| vedere l'archivio | icona **JARVIS Pannello** |
| annullare l'ultima importazione | *JARVIS Foto* → **8** |
| aggiornare JARVIS | menu Start → *JARVIS Foto* → **Aggiorna JARVIS** |
| togliere JARVIS | menu Start → *JARVIS Foto* → **Disinstalla JARVIS**: le foto restano |

Le impostazioni sono in `%LOCALAPPDATA%\JARVIS-Foto\jarvis.config.json` e il registro di quello che fa
la sentinella è in `%LOCALAPPDATA%\JARVIS-Foto\jarvis.log`.

## Pubblicare una nuova versione

1. Carica su GitHub i file modificati (pagina del repository → **Add file → Upload files**).
2. **Releases → Draft a new release** → nuovo tag (es. `v1.3.0`) → **Publish release**.
3. Sul PC: menu Start → **Aggiorna JARVIS**. Impostazioni, archivio e backup restano dove sono.

## Se qualcosa va storto

| Messaggio | Soluzione |
|---|---|
| *Non riesco a leggere le Release…* | il repository è privato, oppure non hai ancora pubblicato la Release (A4) |
| *Nella Release … non c'è il file JARVIS-Foto-Windows.zip* | aspetta che in **Actions** "pacchetto-windows" diventi verde |
| *irm non è riconosciuto…* | stai usando il Prompt dei comandi: apri **Windows PowerShell** |
| la finestra delle domande non compare | *JARVIS Foto* → **9** (riavvia la sentinella), poi **D** |
| niente voce | Impostazioni → Ora e lingua → Voce → aggiungi una voce italiana |
| Windows avvisa "app non riconosciuta" | **Ulteriori informazioni → Esegui comunque** (il programma non è firmato) |
