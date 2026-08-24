// Glossaire métier des acronymes (SGAR PACA / dotations). Versionné ici (v1) ;
// éditable via l'admin en v2 si besoin. Utilisé par le planificateur pour
// développer les acronymes avant l'embedding (cf. point d'audit "acronymes").
export const ACRONYMES: Record<string, string> = {
  ANLCI: "Agence nationale de lutte contre l'illettrisme",
  DSIL: "Dotation de Soutien à l'Investissement Local",
  DSID: "Dotation de Soutien à l'Investissement des Départements",
  DETR: "Dotation d'Équipement des Territoires Ruraux",
  INSEE: "Institut national de la statistique et des études économiques",
  SGAR: 'Secrétariat Général pour les Affaires Régionales',
  LFI: 'Loi de Finances Initiale',
  PACA: "Provence-Alpes-Côte d'Azur",
};

export function renderGlossaire(): string {
  return Object.entries(ACRONYMES)
    .map(([acro, libelle]) => `${acro} = ${libelle}`)
    .join('\n');
}
