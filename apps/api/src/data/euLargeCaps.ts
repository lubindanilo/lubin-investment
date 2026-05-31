/**
 * Liste curée des grandes capitalisations européennes (format symbole Yahoo, ≤ 8 car.
 * pour rester compatible avec le TickerSchema de l'app).
 *
 * Pourquoi une liste statique : Finnhub free ne fournit PAS les listes de symboles hors US
 * (l'endpoint /stock/symbol?exchange=PA… renvoie vide), et il n'existe pas d'API gratuite
 * de constituants d'indices fiable. On seede donc à la main les principaux noms des grands
 * indices (CAC 40, DAX, SMI, FTSE 100, AEX, FTSE MIB, IBEX, BEL, OBX, OMXH…). Le scoring
 * passe par le fallback Yahoo (le nom réel est récupéré au moment de la notation).
 *
 * Extensible : ajouter des tickers ici, relancer le seed EU (idempotent).
 */
export const EU_LARGE_CAPS: string[] = [
  // — Euronext Paris (.PA) —
  'MC.PA', 'OR.PA', 'AIR.PA', 'SU.PA', 'AI.PA', 'EL.PA', 'RMS.PA', 'BNP.PA', 'SAN.PA', 'DG.PA',
  'BN.PA', 'KER.PA', 'SGO.PA', 'ACA.PA', 'GLE.PA', 'CS.PA', 'ENGI.PA', 'VIE.PA', 'ORA.PA', 'CAP.PA',
  'PUB.PA', 'RI.PA', 'HO.PA', 'TTE.PA', 'ML.PA', 'SW.PA', 'DSY.PA', 'LR.PA', 'EN.PA', 'VIV.PA',
  // — Xetra Francfort (.DE) —
  'SAP.DE', 'SIE.DE', 'ALV.DE', 'DTE.DE', 'BAS.DE', 'BAYN.DE', 'BMW.DE', 'MBG.DE', 'VOW3.DE', 'ADS.DE',
  'MUV2.DE', 'DB1.DE', 'IFX.DE', 'RWE.DE', 'MRK.DE', 'HEN3.DE', 'VNA.DE', 'SHL.DE', 'CON.DE', 'FRE.DE',
  'BEI.DE', 'DHL.DE', 'P911.DE', 'RHM.DE', 'EOAN.DE',
  // — Euronext Amsterdam (.AS) —
  'ASML.AS', 'ADYEN.AS', 'INGA.AS', 'AD.AS', 'PHIA.AS', 'HEIA.AS', 'PRX.AS', 'WKL.AS', 'ASM.AS', 'AKZA.AS',
  'KPN.AS', 'ABN.AS', 'MT.AS',
  // — SIX Suisse (.SW) —
  'NESN.SW', 'NOVN.SW', 'ROG.SW', 'ZURN.SW', 'UBSG.SW', 'ABBN.SW', 'CFR.SW', 'SIKA.SW', 'LONN.SW', 'GIVN.SW',
  'SREN.SW', 'ALC.SW', 'PGHN.SW', 'GEBN.SW', 'SCMN.SW', 'HOLN.SW',
  // — London Stock Exchange (.L) —
  'AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'BP.L', 'RIO.L', 'GSK.L', 'DGE.L', 'GLEN.L', 'REL.L',
  'NG.L', 'RKT.L', 'PRU.L', 'VOD.L', 'BARC.L', 'LLOY.L', 'AAL.L', 'STAN.L', 'TSCO.L', 'IMB.L',
  'CPG.L', 'BA.L', 'AV.L', 'SSE.L', 'LSEG.L', 'BATS.L',
  // — Borsa Italiana (.MI) —
  'ENEL.MI', 'ENI.MI', 'ISP.MI', 'UCG.MI', 'STLA.MI', 'RACE.MI', 'G.MI', 'PRY.MI', 'MONC.MI', 'SRG.MI',
  // — Bolsa Madrid (.MC) —
  'IBE.MC', 'ITX.MC', 'BBVA.MC', 'TEF.MC', 'REP.MC', 'AENA.MC', 'FER.MC', 'ELE.MC', 'CLNX.MC', 'SAN.MC',
  // — Bruxelles (.BR) —
  'ABI.BR', 'KBC.BR', 'UCB.BR', 'SOLB.BR', 'GBLB.BR',
  // — Oslo (.OL) —
  'EQNR.OL', 'DNB.OL', 'TEL.OL', 'MOWI.OL', 'NHY.OL',
  // — Helsinki (.HE) —
  'NOKIA.HE', 'SAMPO.HE', 'UPM.HE', 'NESTE.HE', 'KNEBV.HE',
  // — Copenhague (.CO) —
  'DSV.CO', 'GMAB.CO',
];
