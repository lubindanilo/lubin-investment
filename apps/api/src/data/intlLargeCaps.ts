/**
 * Grandes capitalisations internationales (hors US et hors EU déjà couvertes par euLargeCaps).
 *
 * Pourquoi une liste curée : Finnhub free ne liste que les symboles US. Pour le reste du monde
 * on fournit manuellement une sélection de leaders par place boursière, scorés via le fallback
 * Yahoo (resolveYahooTicker sonde le symbole suffixé tel quel).
 *
 * Garantie « données disponibles » : chaque marché ci-dessous a été validé (Yahoo expose
 * bien revenue + FCF sur 4 ans → note /10). Et le pipeline filtre de toute façon : un ticker
 * sans fondamentaux suffisants est marqué `nodata` et n'apparaît jamais dans le screener
 * (il faut scoreChiffresMax ≥ 8). Élargir la liste n'introduit donc aucun faux résultat.
 *
 * Format = symbole Yahoo complet (suffixe d'exchange) :
 *   .TO Toronto · .AX Australie · .ST Stockholm · .CO Copenhague · .OL Oslo · .HE Helsinki
 *   .T Tokyo · .HK Hong Kong · .KS Corée (Séoul) · .NS Inde (NSE) · .TW Taïwan · .SI Singapour · .SA Brésil
 *
 * ⚠️ Asie/Inde/Brésil utilisent des codes numériques (7203.T, 0700.HK, 005930.KS, PETR4.SA) ou
 * des symboles longs (BAJAJFINSV.NS) et certaines classes nordiques un tiret (VOLV-B.ST) →
 * le schéma de ticker accepte chiffres/tiret et jusqu'à 15 caractères (cf. analyze.ts, screener.ts).
 */

// — Canada · Toronto (.TO) —
const CANADA: string[] = [
  // Banques & assurances
  'RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO',
  'MFC.TO', 'SLF.TO', 'GWO.TO', 'IFC.TO', 'FFH.TO', 'IGM.TO', 'EFN.TO', 'ONEX.TO',
  // Énergie & pipelines
  'ENB.TO', 'TRP.TO', 'CNQ.TO', 'SU.TO', 'CVE.TO', 'IMO.TO', 'PPL.TO', 'KEY.TO', 'ARX.TO', 'TOU.TO',
  // Services publics
  'FTS.TO', 'EMA.TO', 'H.TO', 'CU.TO', 'AQN.TO', 'NPI.TO', 'CPX.TO',
  // Rails, transport & industrie
  'CNR.TO', 'CP.TO', 'WCN.TO', 'TFII.TO', 'STN.TO', 'WSP.TO', 'TIH.TO', 'MG.TO', 'LNR.TO', 'DOO.TO',
  // Tech & logiciels
  'SHOP.TO', 'CSU.TO', 'GIB-A.TO', 'OTEX.TO', 'DSG.TO', 'KXS.TO', 'CLS.TO', 'BB.TO',
  // Conso & distribution
  'ATD.TO', 'DOL.TO', 'L.TO', 'MRU.TO', 'QSR.TO', 'WN.TO', 'SAP.TO', 'GIL.TO', 'ATZ.TO', 'MFI.TO', 'PKI.TO',
  // Télécoms & services pro
  'BCE.TO', 'T.TO', 'CIGI.TO', 'FSV.TO', 'X.TO', 'RBA.TO', 'TOY.TO',
  // Mines & matériaux
  'AEM.TO', 'ABX.TO', 'FNV.TO', 'WPM.TO', 'NTR.TO', 'TECK-B.TO', 'FM.TO', 'LUN.TO', 'K.TO', 'WFG.TO',
  // Holdings / divers
  'BN.TO', 'BAM.TO', 'POW.TO', 'TRI.TO', 'CCL-B.TO', 'CTC-A.TO', 'EMP-A.TO',
];

// — Australie (.AX) —
const AUSTRALIA: string[] = [
  // Banques & assurances
  'CBA.AX', 'NAB.AX', 'WBC.AX', 'ANZ.AX', 'MQG.AX', 'SUN.AX', 'IAG.AX', 'QBE.AX', 'ASX.AX',
  // Mines & énergie
  'BHP.AX', 'RIO.AX', 'FMG.AX', 'WDS.AX', 'STO.AX', 'S32.AX', 'NST.AX', 'EVN.AX', 'PLS.AX', 'MIN.AX', 'IGO.AX', 'ORG.AX',
  // Santé
  'CSL.AX', 'RMD.AX', 'COH.AX', 'PME.AX', 'SHL.AX', 'RHC.AX',
  // Conso & distribution
  'WES.AX', 'WOW.AX', 'COL.AX', 'JBH.AX', 'TWE.AX', 'A2M.AX', 'ALL.AX',
  // Tech, immo & infrastructure
  'TLS.AX', 'TCL.AX', 'GMG.AX', 'REA.AX', 'JHX.AX', 'XRO.AX', 'WTC.AX', 'NXT.AX',
  'CAR.AX', 'SEK.AX', 'TNE.AX', 'CWY.AX', 'APA.AX', 'AGL.AX', 'AMC.AX', 'BXB.AX', 'QAN.AX',
  'MGR.AX', 'SCG.AX', 'SGP.AX',
];

// — Japon · Tokyo (.T) — codes numériques —
const JAPAN: string[] = [
  // Auto & équipementiers
  '7203.T', '7267.T', '7269.T', '7270.T', '7201.T', '6902.T',
  // Électronique & semi-conducteurs
  '6758.T', '6861.T', '8035.T', '6594.T', '6981.T', '7741.T', '6503.T', '6857.T', '6920.T',
  '6752.T', '6645.T', '6701.T', '6702.T', '6963.T', '7751.T', '7733.T', '6954.T',
  // Tech & services
  '9984.T', '9434.T', '9433.T', '9432.T', '6098.T', '9983.T', '7974.T', '7832.T', '4661.T',
  // Santé & chimie
  '4502.T', '4519.T', '4503.T', '4568.T', '4578.T', '4523.T', '4543.T', '4901.T', '4063.T',
  '3407.T', '4452.T', '4911.T',
  // Industrie lourde & machines
  '6367.T', '6273.T', '6326.T', '7011.T', '5108.T', '5401.T',
  // Finance
  '8306.T', '8316.T', '8411.T', '8766.T', '8591.T',
  // Trading houses, conso, transport, énergie
  '8058.T', '8001.T', '8031.T', '2914.T', '2802.T', '2502.T', '2503.T', '3382.T', '9843.T', '8267.T',
  '9020.T', '9022.T', '5020.T', '1605.T', '9101.T', '9104.T',
];

// — Hong Kong (.HK) — codes numériques (zéros de tête conservés) —
const HONG_KONG: string[] = [
  // Tech & internet
  '0700.HK', '9988.HK', '3690.HK', '1810.HK', '9618.HK', '9999.HK', '9626.HK', '1024.HK',
  // Finance & bourse
  '1299.HK', '0939.HK', '0388.HK', '0005.HK', '2318.HK', '1398.HK', '2628.HK', '0011.HK', '3968.HK', '1288.HK', '3988.HK',
  // Telecom & énergie & utilities
  '0941.HK', '0728.HK', '0883.HK', '0386.HK', '0857.HK', '0002.HK', '0003.HK',
  // Conso, immo, industrie, santé
  '2020.HK', '2331.HK', '0291.HK', '0027.HK', '1928.HK', '0001.HK', '0012.HK', '0066.HK', '0175.HK',
  '1211.HK', '2015.HK', '9868.HK', '0688.HK', '1109.HK', '2269.HK', '1177.HK',
];

// — Corée du Sud · Séoul (.KS) — codes numériques à 6 chiffres —
const KOREA: string[] = [
  '005930.KS', '000660.KS', '207940.KS', '006400.KS', '009150.KS',
  '005380.KS', '000270.KS', '012330.KS',
  '051910.KS', '096770.KS', '010130.KS', '051900.KS', '090430.KS',
  '035420.KS', '035720.KS', '005490.KS', '011200.KS', '066570.KS', '373220.KS', '003550.KS',
  '105560.KS', '055550.KS', '086790.KS', '316140.KS', '032830.KS', '000810.KS',
  '015760.KS', '017670.KS', '030200.KS', '068270.KS', '028260.KS',
];

// — Suède · Stockholm (.ST) — classes A/B/C (tiret) —
const SWEDEN: string[] = [
  'INVE-B.ST', 'EQT.ST', 'EVO.ST', 'KINV-B.ST', 'LATO-B.ST', 'INDU-C.ST',
  'ATCO-A.ST', 'ATCO-B.ST', 'SAND.ST', 'ALFA.ST', 'SKF-B.ST', 'VOLV-B.ST', 'SAAB-B.ST', 'TREL-B.ST',
  'ERIC-B.ST', 'HEXA-B.ST', 'NIBE-B.ST', 'SINCH.ST', 'ADDT-B.ST', 'TEL2-B.ST', 'TELIA.ST',
  'ASSA-B.ST', 'SECU-B.ST',
  'HM-B.ST', 'ESSITY-B.ST', 'EPI-A.ST', 'AXFO.ST', 'SCA-B.ST', 'HOLM-B.ST',
  'SEB-A.ST', 'SWED-A.ST', 'SHB-A.ST', 'NDA-SE.ST', 'SAVE.ST',
  'BOL.ST', 'GETI-B.ST', 'EKTA-B.ST', 'LIFCO-B.ST', 'CAST.ST', 'BALD-B.ST',
];

// — Danemark · Copenhague (.CO) —
const DENMARK: string[] = [
  'NOVO-B.CO', 'ORSTED.CO', 'CARL-B.CO', 'MAERSK-B.CO', 'DSV.CO',
  'DANSKE.CO', 'VWS.CO', 'COLO-B.CO', 'TRYG.CO', 'GN.CO', 'DEMANT.CO',
  'ROCK-B.CO', 'AMBU-B.CO', 'ISS.CO', 'NETC.CO', 'PNDORA.CO', 'BAVA.CO', 'NSIS-B.CO',
];

// — Norvège (.OL) —
const NORWAY: string[] = [
  'EQNR.OL', 'DNB.OL', 'TEL.OL', 'MOWI.OL', 'NHY.OL',
  'AKRBP.OL', 'ORK.OL', 'KOG.OL', 'YAR.OL', 'SALM.OL', 'STB.OL', 'SUBC.OL',
  'GJF.OL', 'FRO.OL', 'TOM.OL', 'AKER.OL', 'ELK.OL',
];

// — Finlande · Helsinki (.HE) —
const FINLAND: string[] = [
  'NOKIA.HE', 'SAMPO.HE', 'UPM.HE', 'NESTE.HE', 'KNEBV.HE',
  'FORTUM.HE', 'ELISA.HE', 'KESKOB.HE', 'WRT1V.HE', 'STERV.HE', 'TYRES.HE',
  'METSO.HE', 'KCR.HE', 'HUH1V.HE', 'ORNBV.HE', 'TIETO.HE', 'VALMT.HE', 'QTCOM.HE', 'NDA-FI.HE',
];

// — Inde · NSE (.NS) —
const INDIA: string[] = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'HINDUNILVR.NS', 'ITC.NS',
  'SBIN.NS', 'BHARTIARTL.NS', 'KOTAKBANK.NS', 'LT.NS', 'AXISBANK.NS', 'BAJFINANCE.NS', 'ASIANPAINT.NS',
  'MARUTI.NS', 'HCLTECH.NS', 'SUNPHARMA.NS', 'TITAN.NS', 'WIPRO.NS', 'ULTRACEMCO.NS', 'NESTLEIND.NS',
  'POWERGRID.NS', 'NTPC.NS', 'ADANIENT.NS', 'JSWSTEEL.NS', 'ONGC.NS', 'COALINDIA.NS', 'GRASIM.NS',
  'HDFCLIFE.NS', 'SBILIFE.NS', 'BAJAJFINSV.NS', 'DRREDDY.NS', 'CIPLA.NS', 'DIVISLAB.NS', 'BRITANNIA.NS',
  'EICHERMOT.NS', 'HEROMOTOCO.NS', 'BAJAJ-AUTO.NS', 'TECHM.NS', 'DMART.NS', 'PIDILITIND.NS', 'HAVELLS.NS',
  'SIEMENS.NS', 'BOSCHLTD.NS', 'TATAMOTORS.NS', 'TATASTEEL.NS', 'ADANIPORTS.NS', 'APOLLOHOSP.NS',
];

// — Taïwan (.TW) — codes numériques —
const TAIWAN: string[] = [
  '2330.TW', '2317.TW', '2454.TW', '2412.TW', '2308.TW', '2303.TW', '3008.TW', '3711.TW',
  '2882.TW', '2881.TW', '2891.TW', '2886.TW', '2884.TW',
  '1301.TW', '1303.TW', '2002.TW', '2207.TW', '1216.TW',
];

// — Singapour (.SI) —
const SINGAPORE: string[] = [
  'D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'S68.SI', 'C6L.SI', '9CI.SI', 'F34.SI',
  'S63.SI', 'G13.SI', 'Y92.SI', 'BN4.SI', 'U96.SI', 'V03.SI', 'A17U.SI', 'C38U.SI',
];

// — Brésil · B3 (.SA) —
const BRAZIL: string[] = [
  'PETR4.SA', 'PETR3.SA', 'VALE3.SA', 'ITUB4.SA', 'BBDC4.SA', 'BBAS3.SA', 'B3SA3.SA', 'ABEV3.SA',
  'WEGE3.SA', 'ITSA4.SA', 'SUZB3.SA', 'RENT3.SA', 'RADL3.SA', 'PRIO3.SA', 'EQTL3.SA', 'ELET3.SA',
  'GGBR4.SA', 'JBSS3.SA', 'RAIL3.SA', 'CSAN3.SA', 'TOTS3.SA', 'LREN3.SA',
];

/** Univers international curé complet (dédupliqué à l'ingestion). */
export const INTL_LARGE_CAPS: string[] = [
  ...CANADA, ...AUSTRALIA,
  ...JAPAN, ...HONG_KONG, ...KOREA,
  ...SWEDEN, ...DENMARK, ...NORWAY, ...FINLAND,
  ...INDIA, ...TAIWAN, ...SINGAPORE, ...BRAZIL,
];
