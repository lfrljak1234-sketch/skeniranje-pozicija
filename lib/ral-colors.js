// Približne HEX vrijednosti za RAL Classic boje (javno dostupni standardni
// podaci o bojama, ne autorski zaštićen sadržaj) + nekoliko čestih naziva
// eloksažnih/teksturnih završnih obrada koje se pojavljuju u "Finishing"
// stupcu radnih naloga, a nemaju RAL kod.

const RAL_HEX = {
  '1000': '#CCC58F', '1001': '#D0B084', '1002': '#D2AA6D', '1003': '#F9A800',
  '1004': '#E4A010', '1005': '#DC9D00', '1006': '#F09000', '1007': '#F08000',
  '1011': '#AF8A54', '1012': '#DDAF27', '1013': '#EAE6CA', '1014': '#E1CC4F',
  '1015': '#E6D690', '1016': '#EDFF21', '1017': '#F6A950', '1018': '#FACA30',
  '1019': '#A48F7A', '1020': '#A08F65', '1021': '#F6B600', '1023': '#F7B500',
  '1024': '#BA8F4C', '1027': '#A77F0E', '1028': '#FF9B00', '1032': '#D4B02E',
  '1033': '#F8B840', '1034': '#EFA94A', '1035': '#867E67', '1036': '#7A6234',
  '1037': '#F09200',
  '2000': '#DD7907', '2001': '#BE4E20', '2002': '#C63927', '2003': '#FA8228',
  '2004': '#E75B12', '2008': '#F3752C', '2009': '#E15501', '2010': '#D4652F',
  '2011': '#EC7C25', '2012': '#DB6A50',
  '3000': '#AB2524', '3001': '#A02128', '3002': '#A1232B', '3003': '#8D1D2C',
  '3004': '#701F29', '3005': '#5E2028', '3007': '#2E1B21', '3009': '#6B1C23',
  '3011': '#7E292C', '3012': '#CB8D73', '3013': '#9C322E', '3014': '#D17080',
  '3015': '#E1A6AD', '3016': '#AC4034', '3017': '#D3545F', '3018': '#D14152',
  '3020': '#C1121C', '3022': '#D56D56', '3027': '#9D2933', '3028': '#CC2C24',
  '3031': '#AC323B',
  '4001': '#8A5A83', '4002': '#933D50', '4003': '#D15B8F', '4004': '#6D2B37',
  '4005': '#6C4675', '4006': '#8A2C55', '4007': '#3F1728', '4008': '#904684',
  '4009': '#93789E', '4010': '#C63B76', '4011': '#8773A1', '4012': '#6B6880',
  '5000': '#354D73', '5001': '#1F4764', '5002': '#20214F', '5003': '#1D1F2A',
  '5004': '#18171C', '5005': '#1E2460', '5007': '#4E6C8C', '5008': '#393E43',
  '5009': '#26658A', '5010': '#13447C', '5011': '#1E262C', '5012': '#4E7FA8',
  '5013': '#232D53', '5014': '#68829E', '5015': '#2271B3', '5017': '#063971',
  '5018': '#28789A', '5019': '#1A5784', '5020': '#0B4151', '5021': '#00738B',
  '5022': '#232C58', '5023': '#49678D', '5024': '#5D9BC4', '5025': '#28629B',
  '5026': '#102E63',
  '6000': '#327862', '6001': '#387038', '6002': '#28713D', '6003': '#4B573E',
  '6004': '#154536', '6005': '#0F4336', '6006': '#40433B', '6007': '#26392F',
  '6008': '#39352A', '6009': '#27342B', '6010': '#3E753D', '6011': '#698A5E',
  '6012': '#33463B', '6013': '#8B9271', '6014': '#4A4B41', '6015': '#3D403A',
  '6016': '#08683E', '6017': '#448548', '6018': '#57A639', '6019': '#B7D9B1',
  '6020': '#37422F', '6021': '#8A9977', '6024': '#008351', '6025': '#59702B',
  '6026': '#005D52', '6027': '#84C3BE', '6028': '#2C5545', '6029': '#20603D',
  '6032': '#317F43', '6033': '#497E76', '6034': '#7FB0B4', '6037': '#008B29',
  '7000': '#78858B', '7001': '#8F999F', '7002': '#817F68', '7003': '#7A7B6D',
  '7004': '#9EA0A1', '7005': '#6B716F', '7006': '#7E7B65', '7008': '#886950',
  '7009': '#4D5645', '7010': '#585C56', '7011': '#3F4448', '7012': '#4E5754',
  '7013': '#464531', '7015': '#434750', '7016': '#293133', '7021': '#23282B',
  '7022': '#332F2C', '7023': '#817F7D', '7024': '#474A51', '7026': '#374447',
  '7030': '#939388', '7031': '#5D6970', '7032': '#B9B9A8', '7033': '#7C7F73',
  '7034': '#8F8B66', '7035': '#D7D7D7', '7036': '#7F7679', '7037': '#7D7F7D',
  '7038': '#B5B8B1', '7039': '#6B695F', '7040': '#9DA1AA', '7042': '#8F9695',
  '7043': '#4E5451', '7044': '#CAC4B7', '7045': '#909090', '7046': '#828282',
  '7047': '#D0D0D0', '7048': '#9A9697',
  '8000': '#887142', '8001': '#9C6B30', '8002': '#7B5141', '8003': '#80542F',
  '8004': '#8F4E35', '8007': '#6F4A2F', '8008': '#6F4F28', '8011': '#5A3A29',
  '8012': '#673831', '8014': '#472C20', '8015': '#5B3A29', '8016': '#3E2B23',
  '8017': '#45322E', '8019': '#3D3635', '8022': '#212121', '8023': '#A15830',
  '8024': '#795038', '8025': '#755D49', '8028': '#4E3B2B', '8029': '#763C28',
  '9001': '#EDE6D6', '9002': '#D6D3CB', '9003': '#EDEEE8', '9004': '#2A2C2B',
  '9005': '#0A0A0A', '9006': '#A5A8A7', '9007': '#8F8F8C', '9010': '#F5F4EF',
  '9011': '#1D1E20', '9016': '#F1F1EA', '9017': '#292A2C', '9018': '#CFD3CD',
  '9022': '#9C9C9C', '9023': '#87888A'
};

// Nazivi koji se pojavljuju u "Finishing" stupcu bez RAL koda (eloksaža,
// teksturne obrade i sl.) - približna boja za brzi vizualni pregled.
const NAME_HEX = [
  [/soft\s*silver/i, '#C7C9CC'],
  [/silver/i, '#C0C0C0'],
  [/anthracite/i, '#293133'],
  [/buff\s*yellow/i, '#D9B36C'],
  [/bronze/i, '#6E4B2A'],
  [/champagne/i, '#D8C08C'],
  [/gold/i, '#C9A227'],
  [/black/i, '#1A1A1A'],
  [/white/i, '#F2F2F2'],
  [/grey|gray/i, '#8F9192'],
  [/brown/i, '#5A3A29'],
  [/copper/i, '#B25E32']
];

// Izvuci čitljiv naziv boje iz teksta finishinga, npr.
// "PPC-04 | Anthracite Grey (RAL 7016) - Matt Finish" -> "Anthracite Grey"
function extractColorName(finishing) {
  if (!finishing) return null;
  const afterPipe = finishing.split('|')[1] || finishing;
  let t = afterPipe.trim();
  t = t.replace(/^([A-Z]{2,4}(-\d+)?\s*-\s*)/, ''); // ukloni prefiks poput "PPC - "
  t = t.replace(/\([^)]*\)/g, '').trim();            // ukloni "(RAL 7016)" i sl.
  t = t.split(' - ')[0].trim();                       // uzmi dio prije opisa obrade
  return t || null;
}

// Izvuci RAL kod (npr. "RAL 7016") iz teksta finishinga.
function extractRalCode(text) {
  if (!text) return null;
  const m = String(text).match(/RAL\s*(\d{3,4})/i);
  return m ? m[1] : null;
}

// Vrati približnu HEX boju za tekst finishinga, ili null ako se ne prepozna.
function colorForFinishing(text) {
  if (!text) return null;
  const ral = extractRalCode(text);
  if (ral && RAL_HEX[ral]) return RAL_HEX[ral];
  for (const [re, hex] of NAME_HEX) {
    if (re.test(text)) return hex;
  }
  return null;
}

module.exports = { RAL_HEX, extractRalCode, extractColorName, colorForFinishing };
