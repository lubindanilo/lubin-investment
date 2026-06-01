/**
 * Grandes capitalisations internationales (hors US et hors EU déjà couvertes par euLargeCaps).
 *
 * Pourquoi une liste curée : Finnhub free ne liste que les symboles US. Pour le reste du monde
 * on fournit manuellement une sélection de leaders par place boursière, scorés via le fallback
 * Yahoo (resolveYahooTicker sonde le symbole suffixé tel quel).
 *
 * Format = symbole Yahoo complet (suffixe d'exchange) :
 *   .TO Toronto · .AX Australie · .ST Stockholm · .CO Copenhague · .OL Oslo · .HE Helsinki
 *   .T Tokyo · .HK Hong Kong · .KS Corée (Séoul)
 *
 * ⚠️ L'Asie (JP/HK/KR) utilise des codes numériques (7203.T, 0700.HK, 005930.KS) et certaines
 * classes nordiques un tiret (VOLV-B.ST) → le schéma de ticker accepte chiffres/tiret et jusqu'à
 * 12 caractères (cf. analyze.ts, screener.ts).
 */

// — Canada · Toronto (.TO) — banques, énergie, rails, tech, mines —
const CANADA: string[] = [
  'RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO',
  'ENB.TO', 'TRP.TO', 'CNQ.TO', 'SU.TO', 'CVE.TO', 'IMO.TO',
  'CNR.TO', 'CP.TO', 'WCN.TO',
  'SHOP.TO', 'CSU.TO', 'GIB-A.TO', 'OTEX.TO',
  'ATD.TO', 'DOL.TO', 'L.TO', 'MRU.TO', 'QSR.TO', 'WN.TO',
  'BCE.TO', 'T.TO',
  'MFC.TO', 'SLF.TO', 'GWO.TO', 'IFC.TO',
  'BN.TO', 'BAM.TO', 'POW.TO',
  'AEM.TO', 'ABX.TO', 'FNV.TO', 'WPM.TO', 'NTR.TO',
  'TRI.TO', 'FTS.TO', 'MG.TO', 'WSP.TO', 'TIH.TO',
];

// — Australie (.AX) — banques, mines, santé, tech —
const AUSTRALIA: string[] = [
  'CBA.AX', 'NAB.AX', 'WBC.AX', 'ANZ.AX', 'MQG.AX',
  'BHP.AX', 'RIO.AX', 'FMG.AX', 'WDS.AX', 'STO.AX',
  'CSL.AX', 'RMD.AX', 'COH.AX',
  'WES.AX', 'WOW.AX', 'COL.AX',
  'TLS.AX', 'TCL.AX', 'GMG.AX', 'QBE.AX',
  'ALL.AX', 'REA.AX', 'JHX.AX', 'XRO.AX', 'WTC.AX', 'NXT.AX',
];

// — Suède · Stockholm (.ST) — beaucoup de classes B/A (tiret) —
const SWEDEN: string[] = [
  'INVE-B.ST', 'EQT.ST', 'EVO.ST',
  'ATCO-A.ST', 'ATCO-B.ST', 'SAND.ST', 'ALFA.ST', 'SKF-B.ST', 'VOLV-B.ST',
  'ERIC-B.ST', 'HEXA-B.ST', 'NIBE-B.ST',
  'ASSA-B.ST', 'SECU-B.ST',
  'HM-B.ST', 'ESSITY-B.ST', 'EPI-A.ST',
  'SEB-A.ST', 'SWED-A.ST', 'SHB-A.ST', 'NDA-SE.ST',
  'BOL.ST', 'TELIA.ST', 'GETI-B.ST',
];

// — Danemark · Copenhague (.CO) —
const DENMARK: string[] = [
  'NOVO-B.CO', 'ORSTED.CO', 'CARL-B.CO', 'MAERSK-B.CO',
  'DANSKE.CO', 'VWS.CO', 'COLO-B.CO', 'TRYG.CO', 'GN.CO', 'DEMANT.CO',
];

// — Norvège (.OL) — (en complément d'euLargeCaps) —
const NORWAY: string[] = [
  'AKRBP.OL', 'ORK.OL', 'KOG.OL', 'YAR.OL', 'SALM.OL', 'STB.OL', 'SUBC.OL',
];

// — Finlande · Helsinki (.HE) — (en complément d'euLargeCaps) —
const FINLAND: string[] = [
  'FORTUM.HE', 'ELISA.HE', 'KESKOB.HE', 'WRT1V.HE', 'STERV.HE', 'TYRES.HE',
];

// — Japon · Tokyo (.T) — codes numériques à 4 chiffres —
const JAPAN: string[] = [
  '7203.T', '6758.T', '6861.T', '8035.T', '9984.T', '9983.T',
  '4063.T', '6098.T', '8306.T', '6501.T', '7974.T', '6902.T',
  '4502.T', '4519.T', '6594.T', '6367.T', '6273.T', '6981.T',
  '8058.T', '8001.T', '8031.T', '9433.T', '9432.T', '7741.T',
  '4661.T', '7267.T', '7011.T', '2914.T',
];

// — Hong Kong (.HK) — codes numériques à 4 chiffres (zéros de tête conservés) —
const HONG_KONG: string[] = [
  '0700.HK', '9988.HK', '0941.HK', '1299.HK', '0939.HK', '3690.HK',
  '1810.HK', '0388.HK', '0005.HK', '2318.HK', '9618.HK', '1398.HK',
  '0883.HK', '2628.HK', '0016.HK',
];

// — Corée du Sud · Séoul (.KS) — codes numériques à 6 chiffres —
const KOREA: string[] = [
  '005930.KS', '000660.KS', '005380.KS', '051910.KS', '035420.KS',
  '035720.KS', '005490.KS', '105560.KS', '055550.KS', '012330.KS',
];

/** Univers international curé complet (dédupliqué à l'ingestion). */
export const INTL_LARGE_CAPS: string[] = [
  ...CANADA, ...AUSTRALIA,
  ...SWEDEN, ...DENMARK, ...NORWAY, ...FINLAND,
  ...JAPAN, ...HONG_KONG, ...KOREA,
];
