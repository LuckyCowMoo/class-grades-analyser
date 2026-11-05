// Given names and distinctive surnames used to warn before a prompt is sent.
// Ordinary English words that also happen to be names (rose, may, mark, grace)
// are listed in ENGLISH_NAME_WORDS and never counted as a hit.

export function foldName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase();
}

function bag(raw) {
  const out = new Set();
  for (const part of String(raw).split(/[^a-z]+/)) {
    if (part.length >= 3) out.add(part);
  }
  return out;
}

// Words a teacher might write that are also names. Keep this greedy.
const ENGLISH_NAME_WORDS = bag(`
  ace actor actress age aid aim air ale angel animal april ash august autumn
  baby back bad bag ball band bank bar bark barn base basil bat bay beach bean
  bear beat beauty bed bee beech bell berry best bill birch bird bishop black
  blade blank bloom blue boar boat bob body bone book boot born boss bow bowl
  box boy branch brand bread break brick bright brook brown bud burn bush busy
  buy cake cal cam cap car card care carol carpenter case cash cast cat catch
  cedar cell chair chance chapel chase cherry chief child china chip choir
  chop church city clay cliff cloud clover club coal coast coat cock cod coil
  cold cole color colour cook coral core corn cost court coy crab craft crane
  creek crew crop cross crow crystal dale dawn day dean dear debt deer dew
  diamond dirt doctor doe dog doll door dove down drain draw dress drift
  drink drop drum dry duck duke dusk dust eagle earl earth east edge eel egg
  elm end eve even eye fabric face fair fall fan far farm fat fear fern field
  fig file film fin fir fire fish fisher flag flax flint flood floor flow
  flower fly fog foil folk food foot ford forest form fort fox frank frost
  fruit garnet gate gene gift ginger girl glen glory gold good goose grace
  grain grant grape grass gray green grey grit grove guest gun guy hail hair
  hale hall halt ham hand harbor harbour hardy hart   harvest hat hate hawk hay
  haze hazel head health heart heat heaven hedge heel herb hill holly
  home honor honour hope horn horse host house hunter ice ink iris iron ivory
  ivy jackal jade jay jet job joy judge june justice kay kelp key kid king
  kit kite lake lamb lamp lance land lane lark law lawn lead leaf lee left
  lemon life light lily lime line lion   list live loaf lock lodge log long
  look lord love lower luck lung mac major man march mark marsh mason
  may meadow mean meat median merry mile milk   mill miller min mint mist mock
  moon moss moth mouse mud mug name navy nest net night noble north oak
  oar oat odd oil olive orange page palm paper park parker patch pea peace
  peach pear pearl peat pen perch pet pageant pie pig pike pile pine pink
  pitch place plain plane plant plum pole pond pool poppy port porter post
  pot pound prey pride priest prince prize queen quick rain rank reed rest
  rice rich ridge right ring river road rock rod roll roof root rose row ruby
  rue rush ruth rye sage sail saint salt sand sawyer scale school score sea
  seal season seed sergeant set shade shaw sheep sheet shell shepherd shield
  ship shoe shore short shrub side silk silver sky slope snow song south
  spark spear spring square staff stag star steam steel stern stick still
  stone storm straw stream street strong summer sun swamp swan sweep sweet
  swift sword table tail tailor tale target tea team thorn tide tiger tile
  till timber time toddle tom tooth top tower town trace track trail tree
  trout true tube tun turf vale van vase veil vein vest view vine
  violet wade walk walker wall war ward water wave west wheat white wicket
  will willow wind winter wise wolf wood woods wool worm wright yard year
  young
  amber autumn crystal daisy destiny diamond faith fortune genesis glory
  harmony hunter liberty melody mercy destiny precious raven river sky
  summer trinity willow
  max min median mean mode range rank grade grades mark marks score scores
  paper papers topic topics unit units class year form set group groups
  pupil pupils student students teacher teachers school subject subjects
  assessment assessments test tests exam exams mock mocks homework effort
  target targets overview caveat caveats code codes data table tables row
  rows column columns cell cells value values measure measures result
  results progress report reports tracker higher foundation core combined
  calculator non calculator literacy numeracy science english maths
  mathematics history geography french spanish german music drama art
  design food sport pe re rs psce pshe citizenship computing ict
  january february september october november december
  paris india london china
`);

const GIVEN_NAMES = bag(`
  aaliyah aamir aaron aarav aarya aayan abbas abby abdallah abdul abdullah
  muhammad muhamed mohamad muhammed
  abe abel abigail abner abraham adam adela adelaide adele adeline adem
  ademola aden adnaan adnan adriana adrian adrienne advik agatha agnes agnieszka
  ahmad ahmed aicha aidan aiden aisha aishah ajay akira alana alani alannah
  albert alberto alec aleena alejandro aleksander aleksandra alessandra
  alessandro alessia alex alexander alexandra alexandre alexandria alexia
  alexis alfred alfredo ali alia alice alicia alina alisa alisha alison alissa
  alistair aliyah aliza allie allison ally alma alonso aloysius alvaro alvin
  alya alyssa amalia amanda amara amari amaya amberly amelia amelie amina
  aminah amira amirah amit ammar amos amy ana anabel anabella anastasia
  anaya andi andra andre andrea andreas andrei andres andrew andrzej andy
  anel ania anika anisa anita anja anjali ann anna annabel annabella
  annabelle annan anne annette annie anouk ansh anson antal antoine anton
  antonela antonella antoni antonia antonio anushka anwen anya aoife apolline
  apolonia arabella archie arian ariana arianna ariel ariella arjun arlo
  arman armando arnav aron aron artem arthur artur artist asher ashton asia
  asma asmaa astrid aubrey audrey augustine aurelia aurelien aurora austin
  ava avalon avery axel aya ayaan ayan ayana ayanna ayden aylah ayleen aylin
  ayo ayomide aysha ayva azalea aziz azra
  bailey barbara bartek bartlomiej bartosz beatrice beatrix beatriz beau
  bela belen ben benedict benjamin bennett benson bernadette bernard bernardo
  bertha beth bethan bethany betsy betty bianca bilal billy blaise blake
  blizzard blaise bobby bogdan bogna bolek bonnie brad bradley brady
  braiden brandon brayden breanna brenda brendan brendon brennan brian
  briana brianna bridget brigid britney brittany brodie brody bronwyn
  brooke brooklyn bruce bruno bryan bryce bryn bryony buckley
  caelan caitlin caitlyn caleb callie callum calvin cameron camila camilla
  camille campbell camila candace cara carina carla carlos carly carmen
  carolena carolina caroline carolyn carson carter carys casey casper cassandra
  cassidy catalina catherine cathy cecelia cecile cecilia cedric celeste
  celia celine cerys chaima chanel chantal charlene charles charlie charlotte
  chelsea chiamaka chiara chloe chris chrissie christa christabel christelle
  christian christie christina christine christopher chrystal ciara cian
  cidalia cillian cindy clare clarence clarissa claudia claudio clement
  clementine clifford clive clodagh cody colette colin colton conner connor
  conor conrad constance cora coralie corbin cordelia corinne cornelius
  corrina courtney craig cristian cristina crystaline curtis cyprian cyril
  dahlia daisyanne dakota dale dale dale damian damien damon dan daniel
  daniela danielle danilo danny dante daphne dara darcey darcie daria darius
  dariusz darren darryl dave david davide davina davinder dawnmarie dax
  dayana deanna debbie debora deborah declan deepak deirdre denis denise
  dennis derek desmond diana diane diego dieter dilan dilara dilys dimitri
  dina dion diya dolly dolores domenico dominic dominika dominik
  dominykas donovan dora dorian doris dorota dorothy doug douglas drewery
  duncan dwayne dylan
  eabha eamon eamonn ean efe ehan eileen eira eisha elaina elaine elana
  eleanor elena eleni elias elie elijah elin elina elio eliot elisa elisabeth
 elise elisha eliza elizabeth ella ellas elle ellen ellie elliot elliott
  ellis elodie eloise elsa elsie elton elvin elvira emel emelia emelie
  emerson emil emiliano emilie emilija emilio emily emin emma emmanuel
  emmanuelle emme emmet emmett emre ena enzo eoin eric erica erick erik
  erika erin erland ernest ernesto ervin eryk esha eshal esme esmee essa
  essie esther ethel ethan etienne ettie euan eugenie eunice eva evan
  evangelina eve evelina evelyn everly evie evren ewan ezekiel ezra
  fabian fabiola farah faraj farhan farid farida farrah fatima fatimah
  fatma faiza faizan felicia felicity felipe felix ferelith fergus fernando
  finlay finley finn finnley fion fiona fionn fionnuala flavia flora florence
  florian florrie fran frances francesca francesco francis francisco franco
  frankie franklin franz fraser fred freddie frederick freya freja frida
  gabija gabriela gabriel gabriele gabriella gabrielle gael gareth gavin
  gayle gemma genevieve geoffrey george georgi georgia georgie georgina
  gerald geraldine gerard gillian giorgio giovanna giovanni gisele giulia
  giuliano giuseppe glenn gloria graeme graham grainne graeme greg gregory
  greta greta griffin guillaume gwen gwendoline gwendolyn
  habiba hadiya hadley hailey haleema halima hallie hamish hamza hana
  hanan hanan hang hanif hannah hannah hannah hans haris harlan harley
  harlow harmoni harold haroon harriet harris harrison harry hasan hassan
  hayden hayley hazelanne heatheranne heidi helen helena helene hendrik
  henrietta henry hilda hillary hollyanne hugh hugo humaira humphrey hussein
  huw
  iain ian ibrahim ida idris ifeoma ignacio igor ilias ilona ilyas imaan
  iman imani imogen imran inaaya inaya inayah india indigo indira ines
  ines inga ingrid inigo ioana ioan ioannis irene irfan irisanne irma
  irvin irving isaac isabel isabela isabella isabelle isadora isha ishaan
  ishak ishmail ismail isobel isra israel issac ivan iva ivo ivonne iwona
  izabella izabelle
  jace jack jackie jackson jacob jacobo jacques jada jadeanne jaden jaeden
  jagger jaiden jaime jake jakob jakov jakub jamal james jamie jan jana
  jane janelle janet janice janie janine january jaqueline jared jaroslaw
  jasmin jasmineanne jason jasper javier jax jaxon jaxson jayda jayden
  jayla jaylen jayson jean jeanne jeannette jeff jeffrey jemima jemma jenna
  jennifer jenny jenson jeremy jerome jerry jesse jessica jessie jesus
  jibril jill jillian jim jimmie jimmy joachim joan joanna joanne joao
  joaquin jocelyn jodie jody joe joel joelle joey johann johanna john
  johnathan johnny jon jonah jonas jonathan jordan jordyn jorge jorja jose
  josef josefina joseph josephine josh joshua josiah josie jozef juan juana
  judah judith judy jules julia julian juliana julianna julianne julie
  julien juliet julieta julio julius juneanne justin justina justine
  kacper kade kaelan kai kaia kaiden kailani kaira kairo kais kaison kaitlin
  kaleigh kali kamari kamil kamila kamile kamran kane kaplan kara karen
  kari karim karina karl karla karol karolina kasia kasper kate katelyn
  katelynn katharina katherine kathleen kathryn kathy katie katrina katya
  kayden kayla kaylah kaylee kayleigh keanu keira keith kelvin kenji kennedy
  kenneth kenny kent kenzie kevan kevin khadija khadijah khaleesi khalid
  kian kiara kiera kieran kilian killian kimani kimberley kimberly kira
  kiran kirill kirra kirsten kirsty kita knox kobe kofi konrad kora korben
  kristen kristian kristina kristine kristy krzysztof kuba kyla kyle kylen
  kylian kylie kylo kylan kyra kyren
  lacey lacie lana lara larissa larry latifa laura laurel lauren laurence
  lauryn lawrence layla layton lea leah leandro leanna leanne leeanne leif
  leila leilani lela lena lenny leo leon leona leonard leonardo leonidas
  leonie leonora lesley leslie leticia levi lewis lexie lia liam liana
  lila lilah lilian liliana lilianna lillian lilyana lina lincoln linda
  lindsay lindsey linus lionel lisa livia liz liza lizzie logan loic
  lola london lorcan lorenzo loretta lori lorraine lotte lottie louie
  louis louisa louise lourdes lowri luan luca lucas lucia lucian luciana
  lucie lucien lucille lucy ludwik luigi luis luisa lukas luke lula lulu
  lyam lydia lyla lyle lynne lyra lysander
  mabel maciej mackenzie maddison maddox madeline madelyn madison mae
  maeve magda magdalena maggie magnus mahdi mahir maia maisie maisy majid
  malachi malakai malcolm malik mallory malgorzata mandy manon manuel
  manuela mara marc marcel marcelina marcelo marcin marco marcus margaret
  margot maria mariah marian marianne marie mariella mariem marika marley
  marlon marta martha martin martina martine martyna marvin mary maryam
  maryan masie mateo mateusz matias matilda matt matthew matthias matteo
  maud maureen mauricio mavis maxime maximilian maxine maxwell maya mayra
  mckenna megan meghan mehmet mehdi meera mei melanja melissa melodyanne
  mercedes mercyanne mia micah michael michaela michal micheal michel
  michele michelle mick mickey miguel mikayla mike mikolaj milan miles
  milena milo milos milly milo mina mindy mira miracle miranda mirek
  miriam miroslav miser misha mitchell mitchel moira mohamed mohammad
  mohammed moira molly mona monica monika morgan morris moses mustafa
  mya myah myles mylo myra
  nadia nadine nadya nana nancy naomi nash natalia natalie nate nathalie
  nathan nathanael nathaniel nawi nawfal nazia neal neel neha neil nelson
  niamh nicholas nick nicky nico nicola nicolas nicole nigel nikeisha
  nikita nikodem nikola nikolai nikos nileisha nina nisha noah noel noelle
  nolan noor nora norah nouf nour nuala nyla
  ocean octavia oisin oliver olivia oliwia oliwier omar omari ondine oona
  ophelia orla orlaith orlando oscar osian otis otto owen ozzie
  pablo paige paloma pamela paola paolo paris pascal patrycja patryk
  patricia patrick patryk paul paula paulette paulina pauline paulo pawel
  pedro penny percy perry petra pete peter petra philip philippa phillip
  phoebe phoenixanne pia pierre piotr pippa polly preston priscilla priya
  priyanka
  qasim quentin quincy quinn
  rachael rachel rafael rafe raheem rahim rahul raihan raj rajan rajesh
  ralph ramla ramon rania raquel rasheed raul rebecca reece reegan reem
  rehan reid reina reece remi remy renata renee reuben rex reya rhian
  rhianna rhiannon rhys ricardo richard rick ricky riley rita riya robert
  roberta roberto robin robyn rocco rocky roderick rodrigo roger rohan
  roland roman romeo ronak ronald ronan rory rosa rosalie rosalind rosaline
  roseanne rosemary rosie ross rowan rowena roxane roxanne roy ruben rubyanne
  russell ryan ryder rylan
  sabeen sabina sabine sabrina sacha saffie saffron sahar said saif
  sakina salim sally salma sam samantha sami samir samira samson samuel
  sanda sandra sandy sania santiago santino sara sarah sasha saul savanna
  savannah scarlett seb sebastian selena selina selma serena sergio seth
  shae shane shania shannon shaun shauna shay shayan shea sheila shelby
  shirley shona sian sidney sierra silas silvia simon simona simone simran
  sina sioned siri siobhan skye skyelar slawomir sloane sofia sofie
  solomon sonia sonja sonny sophia sophie soraya spenceranne stacey stacy
  stanislaw stanley stefan steffan stella stepan stephanie stephen steve
  steven stevie stuart subhan suhail sukhdev sullivan summeranne susan
  susanna susannah susanne susie suzy syed sylvia sylvie szymon
  tabitha tadhg tahira talha talia talulah tamara tamar tami tammy tamsin
  tanya tara tarik tariq tasnim tayloranne ted teddy teo terence teresa
  tess tessa thalia thea theodora theodore theon thiago thomas tia tiago
  tiffany tilda timothy tina tobias toby todd tomasz tommy tony tonia
  tonya travis trevor tristan troy tyler tyson
  ula umar una uriah ursula usman uthman
  valentina valentino valeria valerie vanessa vera verity vernon veronica
  vicente vicki vicky victor victoria vida viktor vilte vincent viola
  violetta virgil vita vito vivian viviana vivienne vladimir
  walter wanda wayne wendell wendy wesley weston wiktor wiktoria wilfred
  willem william willowanne wilson winnie wojciech wyatt
  xander xavi xavier ximena
  yahya yasir yasin yasmin yasmeen yehuda yosef youssef yusuf yusra
  zahra zain zaina zainab zak zara zarah zayd zayn zbigniew zbyszko zoe
  zoey zofia zofie zola zoltan zora zosia zuri zuzanna
`);

const SURNAMES = bag(`
  abdullah adams ahmed akhtar ali allen anderson andrade
  begum bhatti
  campbell castro chavez chen choi choudhury chowdhury cohen
  davies demir dias diaz duda
  fernandes fernandez
  garcia gomez gonzalez gupta
  hassan hernandez hussain
  ibrahim iqbal islam
  jankowski johansson johnson
  kaminski kaur khalid khan kowalski kowalczyk
  lewandowski liu lopez
  mahmood malik martinez miah mohamed mohammed
  nguyen nowak nowakowski
  oconnor okonkwo oliveira
  patel perez
  rahman ramirez rodriguez
  sanchez santos shah silva singh szymanski
  uddin
  williams wisniewski wozniak
  yang
  zhang zielinski
`);

const NAME_KEYS = new Set([...GIVEN_NAMES, ...SURNAMES].filter((n) => !ENGLISH_NAME_WORDS.has(n)));

const SKIP_ALLCAPS = /^[A-Z]{2,4}$/;
const PUPIL_CODE = /^[A-Z]{1,3}\d{1,4}$/i;

export function scanCommonNames(text) {
  const found = [];
  const seen = new Set();
  const re = /[\p{L}][\p{L}'’\-]*/gu;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const raw = m[0];
    if (SKIP_ALLCAPS.test(raw) || PUPIL_CODE.test(raw)) continue;
    const parts = foldName(raw).split('-').filter(Boolean);
    for (const key of parts.length ? parts : [foldName(raw)]) {
      if (key.length < 3) continue;
      if (ENGLISH_NAME_WORDS.has(key)) continue;
      if (!NAME_KEYS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ match: raw, key, index: m.index });
    }
  }
  return found;
}
