// THE STYLE REGISTRY, AND THE CHOOSER.
//
// Pulled out of the renderer so it can be MEASURED. Nothing in here touches
// three.js, MapLibre, the DOM or a GL context — it is the tables that say what
// facade families exist, which traits each belongs to, and the pool logic that
// decides which one a given building wears. Keeping it free of those imports is
// the whole point: it means a Node probe can walk every building of every
// generated city across a dozen seeds and report the distribution, which is not
// something you can eyeball from one screenshot of one town.
//
// That matters more than it looks. Every city in this game is procedurally
// generated from a seed, so "does this style ever get drawn" is a question about
// a DISTRIBUTION and not about a screenshot — and a family gated behind a
// condition the generator never produces is dead code that still compiles. Six
// were found that way, and they were only found by counting.
import type { BuildingVolume } from "./volume";

/**
 * A 32-bit key from a BBL, in EXACT integer arithmetic — FNV over the digits,
 * because `Number(bbl) * PRIME` is past 2^53 for a ten-digit BBL and quietly
 * discards its low bits.
 */
export function keyOf(bbl: string): number {
  let h = 2166136261;
  for (let i = 0; i < bbl.length; i++) { h ^= bbl.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * A well-mixed [0,1) from two integers. Two calls with different constants give
 * two INDEPENDENT streams, which is the whole point — the old scheme derived
 * its second scalar from its first, so colour and detail moved together.
 */
export function hash01(a: number, b: number): number {
  let x = (Math.imul(a, 2654435761) ^ Math.imul(b, 2246822519)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}


export const S_GLASS = 0;   // modern curtain wall (sky-reflecting)
export const S_PREWAR = 1;  // punched masonry: limestone / brownstone / painted
export const S_BRICK = 2;   // residential brick, four hues
export const S_MILL = 3;    // industrial sash
export const S_DARK = 4;    // dark premium tower, gold glazing
export const S_PLAIN = 5;   // ships, cranes, sheds
export const S_ARTDECO = 6; // vertical stone piers, 1920s–50s towers
export const S_RIBBON = 7;  // mid-century ribbon windows
export const S_CORNICE = 8; // cornice stonework
export const S_GREEN = 9;   // green roof
export const S_LOT = 10;    // vacant lot: gravel + fence
export const S_GABLE = 11;  // pitched shingle roof
export const S_LAWN = 12;   // park turf
export const S_PATH = 13;   // park walk: compacted buff gravel
export const S_POND = 14;   // park water
// THE MODERN TOWERS THIS CITY HAD NEVER BUILT.
//
// Every tower after 1975 came out of the same two hats — S_GLASS, a 1980s
// curtain wall with a spandrel band at every floor, or S_DARK, its bronze
// cousin. Both are punched-and-banded buildings wearing glass; neither is what
// anyone means by a modern glass tower, and a skyline of nothing else is why
// the new stock reads as one building repeated. These three are the families
// New York actually put up, and they differ in ARCHITECTURE rather than in
// colour: how the glass meets the floor plate, whether the structure is inside
// or outside, and what the wall is made of when it is not glass.
export const S_CRYSTAL = 15; // frameless floor-to-ceiling vision glass — 7 WTC, One WTC, Manhattan West
export const S_DIAGRID = 16; // structure worn on the outside — Hearst Tower, the Bow
export const S_PMOD = 17;    // postmodern polished granite and punched glass — 550 Madison, Worldwide Plaza

// ---------------------------------------------------------------------------
// THE OTHER HUNDRED AND FIFTY YEARS.
//
// Eighteen slots covered the whole history of building, and ten of them were
// facades. One of those ten carried 2,403 buildings and another carried 1,655
// — so 71% of the city was painted by two families. The eye does not read a
// palette, it reads a TYPE: a cast-iron front is not a limestone front in a
// different colour, it is a different building, with different proportions,
// a different structural rhythm and a different window.
//
// These are the families an American port city actually accumulates between
// 1790 and 2030. Each one is defined by the thing you could identify it by
// from across a harbour, and each is implemented as that one signature rather
// than as a hue: the arch, the pier, the band, the balcony, the slot.
//
// --- built before the war ---
export const S_CASTIRON = 18;   // SoHo loft front: painted iron colonnettes, arched bays, more glass than wall
export const S_ROMANESQUE = 19; // Richardsonian: rusticated stone, heavy round arcades, deep shadow
export const S_GOTHIC = 20;     // terra-cotta Gothic: pointed heads, crocketed piers — the Woolworth family
export const S_BEAUX = 21;      // Beaux-Arts: rusticated base, giant order through the middle, huge cornice
export const S_EMPIRE = 22;     // Second Empire: segmental heads, bracket rhythm, a mansard over it
export const S_ITALIANATE = 23; // bracketed cornice, tall round-head windows, painted brownstone
export const S_FEDERAL = 24;    // Federal / Greek Revival: small panes, flat splayed lintels, white trim
export const S_TENEMENT = 25;   // the walk-up: tight window rhythm, painted brick, iron on the front
export const S_CHICAGO = 26;    // Chicago school: tripartite, wide Chicago window, terra-cotta grid
export const S_TERRACOTTA = 27; // glazed white terra cotta — glossy, crisp, and it never got dirty the same way
export const S_MODERNE = 28;    // Streamline Moderne: horizontal bands, rounded corner, glass block
export const S_CIVIC = 29;      // stripped classicism: giant pilasters, deep reveals, pale granite
export const S_CARRIAGE = 30;   // carriage house / stable: one big arch below, a hayloft door above
export const S_MARKET = 31;     // market hall: clerestory over a big arched arcade
// --- built after it ---
export const S_INTL = 32;       // International Style: bronze steel I-beam mullions — the Seagram family
export const S_PRECAST = 33;    // precast eggcrate: a concrete waffle with the window deep inside each cell
export const S_BRUTAL = 34;     // board-formed concrete, narrow deep slots, no expressed floor
export const S_MIRROR = 35;     // 1970s mirror glass: no mullion you can see, and it reflects everything
export const S_METALPAN = 36;   // corrugated metal shed — the working waterfront's modern skin
export const S_EIFS = 37;       // stucco infill: thin punched openings, a colour somebody chose from a chart
export const S_GARAGE = 38;     // parking deck: open decks, spandrel rails, and no glass at all
export const S_PROJECT = 39;    // postwar brick slab: paired windows, absolute regularity
export const S_WHITEBRICK = 40; // 1960s glazed white brick apartment, with its balcony slot
export const S_BALCONY = 41;    // balcony tower: the slab edge is the architecture
export const S_FRIT = 42;       // fritted unitized glass — a ceramic dot pattern that reads as a gradient
export const S_TIMBER = 43;     // mass timber: warm wood spandrels between big square openings
export const S_SCREEN = 44;     // rainscreen: terracotta baguettes or perforated metal in front of the glass
export const S_BIGBOX = 45;     // big-box retail: a blank field under a parapet sign band

// ---------------------------------------------------------------------------
// THE TOWER SKINS OF THE LAST TEN YEARS.
//
// Everything above stops around 2010. What has actually gone up in New York
// since is a different animal again, and none of it is the 1980s curtain wall
// the word "glass tower" still summons: the wall got a THICKNESS back. One
// Vanderbilt and 111 West 57th hang terracotta and bronze piers off the face;
// 55 Hudson Yards punches frames half a metre deep; 425 Park wears its steel
// on the outside as horizontal shelves. Even the plainest of them — One
// Manhattan West, 50 Hudson Yards — is a unitised wall with a mullion rhythm
// fine enough to read as fabric rather than as a mirror.
//
// These five are what a tower over twenty storeys built in the last decade is
// made of, and they differ, as everything above does, in ARCHITECTURE.
export const S_TERRAPIER = 46;  // bronze/terracotta piers running unbroken, glass between — One Vanderbilt, 111 W 57th
export const S_DEEPFRAME = 47;  // frames punched half a metre deep, so the wall is mostly its own shadow — 55 Hudson Yards
export const S_STEELSHELF = 48; // structure worn outside as horizontal shelves — 425 Park Avenue
export const S_UNITGLASS = 49;  // contemporary unitised wall: a fine mullion rhythm and panel-to-panel tint
export const S_MEGAPANEL = 50;  // two-storey mega panels with an expressed shadow box between them

// ---------------------------------------------------------------------------
// THE WORKING CITY.
//
// Every building that made something was one style — S_MILL, an industrial
// sash — and a port city's industry is not one building. A gasholder, a grain
// elevator, a power station, a cold store and a brewery share nothing at all:
// they are different SHAPES holding different things, and what they look like
// follows entirely from what is inside them. This is the part of the city the
// game is named after and it had the least in it.
export const S_POWERHOUSE = 51;  // generating station: giant arched bays, engine-hall scale
export const S_COLDSTORE = 52;   // insulated brick, almost no openings, and a stack of loading doors
export const S_BREWERY = 53;     // brick with segmental arches, a stair tower and a copper vent
export const S_FOUNDRY = 54;     // steel sash to the roof, sooted, with a monitor over it
export const S_GRAINHOUSE = 55;  // slip-formed concrete silos: vertical drums, no windows at all
export const S_GASHOLDER = 56;   // a lattice guide frame round a drum that goes up and down
export const S_SHIPSHED = 57;    // shipyard fabrication shed: portal frame, crane rail, vast doors
export const S_TEXTILE = 58;     // the multi-storey mill: bay after identical bay, and a stair tower
export const S_DEPOT = 59;       // rail depot: a long platform canopy on iron columns
export const S_PUMPHOUSE = 60;   // a small brick temple with one enormous window, built round a pump

// ---------------------------------------------------------------------------
// THE BUILDINGS A TOWN HAS ONE OF.
//
// A city is not only fabric. It is also the firehouse, the library, the bank
// with columns, the hotel, the department store, the picture palace — the
// buildings everybody can name, which are the ones that make a place somewhere
// rather than anywhere. Almost none of them look like the block next door, and
// that is the entire point of them.
export const S_QUEENANNE = 61;   // turret, shingled gable, bay windows — the 1890s house
export const S_STICK = 62;       // exposed framing laid over the boards, in a contrast colour
export const S_TUDOR = 63;       // half-timbering over render, on the upper floors only
export const S_MISSION = 64;     // curved shaped parapet and a tiled pent over the openings
export const S_THEATRE = 65;     // a blind box behind a marquee and a vertical blade sign
export const S_DINER = 66;       // a stainless railcar: horizontal flutes, a band of glass
export const S_FIREHOUSE = 67;   // apparatus doors that are most of the ground floor
export const S_SCHOOL = 68;      // banks of tall windows in threes, and a raised entrance bay
export const S_LIBRARY = 69;     // a portico, and tall arched windows above a blind plinth
export const S_BANKTEMPLE = 70;  // a giant order across the front and no windows at grade
export const S_HOTEL = 71;       // rusticated base, banded middle, heavy cornice, a canopy
export const S_DEPTSTORE = 72;   // continuous display glazing, floor after floor of it
export const S_MOTEL = 73;       // an exterior walkway with a rail, and every door on it
export const S_STRIPMALL = 74;   // deep canopy over continuous glazing, sign band above

// ---------------------------------------------------------------------------
// THE MODERN WORKING BUILDING.
//
// The industrial types above are all pre-war — brick, steel sash, a chimney.
// What America has actually built since 1960 is a completely different animal
// and the game had none of it: a TILT-UP, where the walls are cast flat on the
// slab and stood up by crane, which is why they come in panels seven metres
// wide with a joint between each one. That single construction fact is the
// entire look, and it is now the most common industrial building on earth.
export const S_TILTUP = 75;      // cast flat, stood up by crane: panel joints and reveal bands
export const S_DISTCENTER = 76;  // the big shed: a quarter-mile of dock doors and nothing else
export const S_FLEX = 77;        // a glazed office corner bolted to a metal warehouse
export const S_QUONSET = 78;     // a corrugated half-cylinder, and the end is all door
export const S_TRUCKTERM = 79;   // cross-dock: doors down BOTH long sides, canopy over each
export const S_SELFSTOR = 80;    // rank upon rank of roller doors under one bright band
export const S_DATACENTER = 81;  // a blind box with louvre banks and no windows anywhere

// ---------------------------------------------------------------------------
// HOW PEOPLE ACTUALLY LIVE.
//
// Multifamily is the largest class in every city here and it spanned the fewest
// families — brick, tenement, project, white brick and a handful of towers.
// But housing is the most VARIED thing a country builds, because it is the only
// building type that gets made by ordinary people with local timber and no
// architect. A triple-decker, a shotgun and a bungalow share nothing at all.
export const S_TRIPLEDECK = 82;  // stacked open porches, three floors of them, one per family
export const S_SHOTGUN = 83;     // one room wide and four deep: a door, a window, a gable
export const S_GAMBREL = 84;     // the Dutch barn roof, with flared eaves over the wall head
export const S_FOURSQUARE = 85;  // a cube with a hipped roof, one big dormer, full-width porch
export const S_BUNGALOW = 86;    // deep eaves on exposed rafters, and tapered porch piers
export const S_SRO = 87;         // a hundred identical tiny windows: one room, one man, one bulb
export const S_ORIEL = 88;       // a bay window carried the full height of the front
export const S_TWOFLAT = 89;     // raised basement, a bowed bay, flat roof, two doors
export const S_RANCH = 90;       // long, low, a picture window and the garage on the front
export const S_GARDENAPT = 91;   // two storeys round a lawn, with open breezeway stairs
export const S_MANSIONBLK = 92;  // a porte-cochere, and the same window ninety times
export const S_BACKTOBACK = 93;  // the cheapest terrace ever built: one room per floor

// ---------------------------------------------------------------------------
// WHAT A CITY BUILDS FOR EVERYBODY.
//
// The civic batch covered the buildings a town has one of. These are the ones
// it builds for reasons that are not commercial at all — worship, medicine,
// punishment, learning, washing — and each is shaped by a requirement no shop
// or office has. A cellblock's windows run at twice the floor frequency
// because a cell tier is half a storey. A museum is blind because the light
// comes from the roof. A pavilion hospital is half open because in 1880 the
// cure for everything was fresh air.
export const S_CHURCHSTONE = 94; // stepped stone buttresses and a rose wheel high on one bay
export const S_MEETINGHSE = 95;  // clapboard lap-lines and white-cased twelve-over-twelve sash
export const S_SYNAGOGUE = 96;   // horseshoe heads over banded stone, and a six-spoke wheel
export const S_HOSPITAL = 97;    // every floor half open: a recessed veranda in deep shade
export const S_CELLBLOCK = 98;   // openings at TWICE the floor frequency, barred, in blank ashlar
export const S_ARMORY = 99;      // merlons and embrasures over a corbel course and a battered base
export const S_COLLEGIATE = 100; // stone mullions splitting each window into four lights and a transom
export const S_BATHHOUSE = 101;  // one enormous thermal lunette per bay in white glazed terracotta
export const S_MUSEUM = 102;     // a blind box that opens only in the last metre, under a cornice slot
export const S_CONVENT = 103;    // a cloister arcade at HALF the upper bay pitch, then cell windows

// ---------------------------------------------------------------------------
// THE BUILDINGS THAT MOVE THINGS, OR MAKE THE CITY WORK.
//
// Infrastructure was entirely absent. These are not commercial buildings and
// they do not look like any: a train shed is one arch, a substation is a comb
// of louvre with no glass in it at all, a telephone exchange is deliberately
// almost blind because there is nothing inside that needs a view. Each is the
// shape of one piece of equipment, wrapped just enough to keep the rain off.
export const S_TRAINSHED = 104;   // one colossal glazed lunette, its bars radiating from a single centre
export const S_CARBARN = 105;     // a row of segmental track arches with fanlights over board leaves
export const S_HANGAR = 106;      // the lower two thirds is ONE door in a dozen leaves
export const S_BUSCANOPY = 107;   // a canopy slab cantilevering clear, and everything under it in shade
export const S_CONTROLTWR = 108;  // a blind battered shaft under a cab whose glass leans out over it
export const S_EXCHANGE = 109;    // almost blind brick: one deep slot per floor on half the bays
export const S_SUBSTATION = 110;  // a wall combed with louvre from top to bottom and no glass anywhere
export const S_LIGHTHOUSE = 111;  // a shaft that narrows as it rises, shaded as a cylinder, black gallery

// ---------------------------------------------------------------------------
// WHAT IS BEING BUILT NOW.
//
// The modern end of this registry was still thin: a tall building after 2010
// came out of a hat of five glass skins, and the ordinary modern mid-rise came
// out of EIFS. Neither is what a city puts up today.
//
// The single largest omission was the PODIUM WRAP — five storeys of timber
// frame over a concrete podium, clad in fibre-cement panels in blocks of three
// or four colours. It is by a wide margin the most-built building type in
// America since 2000, it is instantly recognisable, and the game had none.
//
// The tower skins below differ in how the glass MEETS THE AIR — folded,
// shingled, doubled, braced, planted — because on a building with no windows
// to speak of and no masonry at all, that is the only thing left to read.
export const S_SKYGARDEN = 112;   // planted terraces at every level: the tower is half foliage
export const S_PLEATED = 113;     // the glass is FOLDED in plan, so every bay has a lit and a shaded flank
export const S_SHINGLED = 114;    // overlapping panels each leaning out, like scales on a fish
export const S_DOUBLESKIN = 115;  // a second glass layer with a visible cavity and walkways inside it
export const S_MEGABRACE = 116;   // one giant cross-brace spanning eight floors, not a fine diagrid
export const S_CHEVRON = 117;     // facets alternating left and right up the building, a zigzag in plan
export const S_MODULAR = 118;     // stacked prefab boxes: a visible joint round every single module
export const S_PVCLAD = 119;      // photovoltaic spandrel — near-black, glossy, and gridded
export const S_PODIUMWRAP = 120;  // 5-over-1: fibre cement in blocks of colour over a glazed podium
export const S_LABBLDG = 121;     // life sciences: ribbon glass under an enormous mechanical penthouse
export const S_CREATIVE = 122;    // creative office: exposed frame and industrial-scale glazing
export const S_MICROUNIT = 123;   // micro-apartments: the tightest window rhythm in the city
export const S_PASSIVE = 124;     // passive house: thick walls, small deep openings, dead flat render
export const S_MEDIAFACE = 125;   // a corner podium with an LED media band wrapping it

// ---------------------------------------------------------------------------
// OFFICE, AS A PRODUCT.
//
// Everything above is architecture. This is the stock a leasing agent actually
// has on a list, and most of it is not downtown: a medical building beside a
// hospital, a two-storey professional block over a car park, a back-office
// campus nobody has ever looked at. They are the buildings this game is ABOUT
// and they were the thinnest part of the registry.
export const S_MEDOFFICE = 126;   // medical: precast, punched, a canopy, a pharmacy at grade
export const S_OFFICEPARK = 127;  // suburban low-rise: reflective ribbon, three storeys, a berm
export const S_GARDENOFF = 128;   // executive garden office: brick, hipped roof, domestic scale
export const S_BACKOFFICE = 129;  // an operations centre: enormous plate, almost no window
export const S_CAMPUSBLOCK = 130; // corporate campus: very long, very low, entirely horizontal
export const S_INSURANCE = 131;   // the 1960s company slab: a precast grid, identical for 200 m
export const S_GOVLEASE = 132;    // leased government: blank precast and a security setback
export const S_CARRIERHTL = 133;  // a carrier hotel: blank, heavy, louvre where windows go
export const S_LOFTOFFICE = 134;  // a mill re-glazed: old openings, new frameless glass inside
export const S_SKYLOBBY = 135;    // a trophy tower that shifts plate at its sky lobby
export const S_PROFBLDG = 136;    // the two-storey professional block: shallow, glazed, a walkway
export const S_BOUTIQUEOFF = 137; // small and expensive: stone, deep reveals, one storey of glass
export const S_BTSHQ = 138;       // build-to-suit: a logo band where a cornice would be

// ---------------------------------------------------------------------------
// RETAIL, AS A PRODUCT.
//
// Retail is not one thing either. An anchor is a windowless box with a portal
// cut in it; a freestanding pharmacy is a brick pavilion with a rotunda on the
// corner; a lifestyle centre is a single building pretending to be eight. They
// differ by FORMAT — how the tenant meets the car park — more than by style.
export const S_MALLANCHOR = 139;  // a blank department box with one portal cut into it
export const S_LIFESTYLE = 140;   // one building pretending to be eight, with eight fascias
export const S_POWERINLINE = 141; // the inline run: blank above, glass below, pylon signs
export const S_JRBOX = 142;       // junior box: a gable parapet and one band of colour
export const S_AUTOPARTS = 143;   // split-face block under a bright band the colour of the chain
export const S_FASTFOOD = 144;    // small, a canopy, and a drive lane wrapping one end
export const S_BANKBRANCH = 145;  // a brick pavilion with a drive-up canopy on a limb
export const S_PHARMACY = 146;    // brick with a ROTUNDA on the corner, because the corner is the door
export const S_GROCERY = 147;     // an arcade front under one big gable, and cart bays
export const S_RESTAURANT = 148;  // varied roof, a patio wall, awnings on every opening
export const S_SHOWROOM = 149;    // full-height glass, because the stock IS the display
export const S_OUTLET = 150;      // a covered walkway the whole length, gable after gable
export const S_CORNERRETAIL = 151;// urban corner: glazed to the pavement under a deep canopy

// ---------------------------------------------------------------------------
// TRAITS, NOT NUMBERS.
//
// Downstream behaviour was keyed to the numeric VALUE of a style id — `s < 8`
// decided which buildings got a floor line, `s <= 4 || s == 6 || s == 7`
// decided which got shops at grade. Those tests were correct for the eighteen
// ids that existed and are silently wrong for every id added after them: a
// cast-iron loft front is the most shopfronted building type in this city and
// `s <= 4` says it has no shops.
//
// So membership is declared once, here, and every test downstream — in TS and
// in GLSL, which is generated from these same arrays — asks the question by
// name. Adding a style is adding it to the lists it belongs to.

/** Punched openings in a load-bearing wall: string courses, arches, quoins. */
export const T_MASONRY = [
  S_PREWAR, S_BRICK, S_MILL, S_ROMANESQUE, S_BEAUX, S_EMPIRE, S_ITALIANATE,
  S_FEDERAL, S_TENEMENT, S_CIVIC, S_CARRIAGE, S_MARKET, S_GOTHIC, S_TERRACOTTA,
  S_CHICAGO, S_PROJECT, S_WHITEBRICK, S_EIFS, S_PODIUMWRAP, S_MICROUNIT, S_PASSIVE,
  S_MEDOFFICE, S_GARDENOFF, S_INSURANCE, S_GOVLEASE, S_BOUTIQUEOFF,
  S_POWERHOUSE, S_COLDSTORE, S_BREWERY, S_TEXTILE, S_PUMPHOUSE, S_DEPOT,
  S_QUEENANNE, S_TUDOR, S_MISSION, S_FIREHOUSE, S_SCHOOL, S_LIBRARY,
  S_BANKTEMPLE, S_HOTEL, S_THEATRE,
  S_SRO, S_ORIEL, S_TWOFLAT, S_MANSIONBLK, S_BACKTOBACK, S_GARDENAPT,
  S_CHURCHSTONE, S_SYNAGOGUE, S_HOSPITAL, S_CELLBLOCK, S_ARMORY, S_COLLEGIATE,
  S_BATHHOUSE, S_MUSEUM, S_CONVENT,
  S_CARBARN, S_EXCHANGE, S_TRAINSHED,
];

/** Reflects the sky and throws a specular back at the sun. */
export const T_GLASSY = [
  S_GLASS, S_DARK, S_RIBBON, S_CRYSTAL, S_DIAGRID, S_CASTIRON, S_INTL,
  S_MIRROR, S_FRIT, S_SCREEN, S_BALCONY, S_MODERNE,
  S_TERRAPIER, S_UNITGLASS, S_MEGAPANEL, S_STEELSHELF,
  S_SKYGARDEN, S_PLEATED, S_SHINGLED, S_DOUBLESKIN, S_MEGABRACE, S_CHEVRON,
  S_PVCLAD, S_CREATIVE, S_MEDIAFACE,
  S_OFFICEPARK, S_CAMPUSBLOCK, S_SKYLOBBY, S_PROFBLDG, S_LOFTOFFICE,
  S_SHOWROOM, S_CORNERRETAIL,
];

/** Meets the pavement as shopfronts rather than as more wall. */
export const T_TRADE = [
  S_GLASS, S_PREWAR, S_BRICK, S_MILL, S_DARK, S_ARTDECO, S_RIBBON, S_CASTIRON,
  S_ROMANESQUE, S_GOTHIC, S_BEAUX, S_EMPIRE, S_ITALIANATE, S_CHICAGO,
  S_TERRACOTTA, S_MODERNE, S_MARKET, S_INTL, S_PMOD, S_EIFS, S_TIMBER,
  S_WHITEBRICK, S_TENEMENT,
  S_TERRAPIER, S_UNITGLASS, S_MEGAPANEL, S_STEELSHELF, S_DEEPFRAME,
  S_DEPOT, S_PUMPHOUSE,
  S_PODIUMWRAP, S_CREATIVE, S_MEDIAFACE, S_LABBLDG,
  S_MEDOFFICE, S_OFFICEPARK, S_PROFBLDG, S_BOUTIQUEOFF, S_LOFTOFFICE, S_BTSHQ,
  S_LIFESTYLE, S_POWERINLINE, S_JRBOX, S_AUTOPARTS, S_FASTFOOD, S_BANKBRANCH,
  S_PHARMACY, S_GROCERY, S_RESTAURANT, S_SHOWROOM, S_OUTLET, S_CORNERRETAIL,
  S_THEATRE, S_DINER, S_HOTEL, S_DEPTSTORE, S_STRIPMALL, S_MISSION, S_BANKTEMPLE,
  S_FLEX, S_TWOFLAT, S_ORIEL, S_MANSIONBLK, S_SRO,
];

/** Expresses its floor line as a shadow under every storey. */
export const T_FLOORLINE = [
  S_GLASS, S_PREWAR, S_BRICK, S_MILL, S_DARK, S_ARTDECO, S_RIBBON, S_PMOD,
  S_CASTIRON, S_ROMANESQUE, S_GOTHIC, S_BEAUX, S_EMPIRE, S_ITALIANATE,
  S_FEDERAL, S_TENEMENT, S_CHICAGO, S_TERRACOTTA, S_MODERNE, S_CIVIC,
  S_MARKET, S_INTL, S_PRECAST, S_PROJECT, S_WHITEBRICK, S_BALCONY, S_TIMBER,
  S_EIFS, S_FRIT, S_STEELSHELF, S_MEGAPANEL, S_DEEPFRAME,
  S_PODIUMWRAP, S_MICROUNIT, S_PASSIVE, S_LABBLDG, S_CREATIVE, S_MODULAR,
  S_MEDOFFICE, S_OFFICEPARK, S_GARDENOFF, S_INSURANCE, S_GOVLEASE, S_SKYLOBBY,
  S_PROFBLDG, S_BOUTIQUEOFF, S_BTSHQ, S_LOFTOFFICE, S_CAMPUSBLOCK,
  S_LIFESTYLE, S_POWERINLINE, S_JRBOX, S_BANKBRANCH, S_PHARMACY, S_GROCERY,
  S_RESTAURANT, S_SHOWROOM, S_OUTLET, S_CORNERRETAIL,
  S_POWERHOUSE, S_BREWERY, S_TEXTILE, S_FOUNDRY, S_DEPOT,
  S_QUEENANNE, S_STICK, S_TUDOR, S_MISSION, S_SCHOOL, S_LIBRARY, S_HOTEL,
  S_DEPTSTORE, S_MOTEL, S_FIREHOUSE, S_BANKTEMPLE, S_TILTUP, S_FLEX,
  S_TRIPLEDECK, S_SHOTGUN, S_GAMBREL, S_FOURSQUARE, S_BUNGALOW, S_SRO,
  S_ORIEL, S_TWOFLAT, S_RANCH, S_GARDENAPT, S_MANSIONBLK, S_BACKTOBACK,
  S_CHURCHSTONE, S_MEETINGHSE, S_SYNAGOGUE, S_HOSPITAL, S_CELLBLOCK, S_ARMORY,
  S_COLLEGIATE, S_BATHHOUSE, S_MUSEUM, S_CONVENT,
  S_TRAINSHED, S_CARBARN, S_BUSCANOPY, S_EXCHANGE, S_LIGHTHOUSE,
];

/** A modern skin whose parapet is metal or stone rather than more of itself. */
export const T_CAPPED_STONE = [S_GLASS, S_DARK, S_MIRROR, S_FRIT];
export const T_CAPPED_PLAIN = [
  S_CRYSTAL, S_DIAGRID, S_SCREEN, S_BALCONY, S_METALPAN, S_GARAGE, S_BIGBOX,
  S_TERRAPIER, S_DEEPFRAME, S_STEELSHELF, S_UNITGLASS, S_MEGAPANEL,
  S_GRAINHOUSE, S_GASHOLDER, S_SHIPSHED, S_DINER, S_STRIPMALL, S_MOTEL,
  S_TILTUP, S_DISTCENTER, S_FLEX, S_QUONSET, S_TRUCKTERM, S_SELFSTOR, S_DATACENTER,
  S_HANGAR, S_SUBSTATION, S_CONTROLTWR, S_LIGHTHOUSE,
  S_SKYGARDEN, S_PLEATED, S_SHINGLED, S_DOUBLESKIN, S_MEGABRACE, S_CHEVRON,
  S_MODULAR, S_PVCLAD, S_PODIUMWRAP, S_LABBLDG, S_CREATIVE, S_MEDIAFACE,
  S_BACKOFFICE, S_CARRIERHTL, S_GOVLEASE, S_CAMPUSBLOCK,
  S_MALLANCHOR, S_AUTOPARTS, S_FASTFOOD, S_JRBOX, S_OUTLET,
];

/** Reads as a modern building when a crown is being chosen for it. */
export const T_MODERN = [
  S_GLASS, S_DARK, S_RIBBON, S_CRYSTAL, S_DIAGRID, S_INTL, S_MIRROR, S_FRIT,
  S_SCREEN, S_BALCONY, S_PRECAST, S_BRUTAL, S_TIMBER, S_WHITEBRICK, S_PROJECT,
  S_TERRAPIER, S_DEEPFRAME, S_STEELSHELF, S_UNITGLASS, S_MEGAPANEL,
  S_TILTUP, S_DISTCENTER, S_FLEX, S_DATACENTER,
];

/** Reads as cut stone when a crown is being chosen for it. */
export const T_STONE = [
  S_PREWAR, S_ARTDECO, S_CORNICE, S_PMOD, S_ROMANESQUE, S_GOTHIC, S_BEAUX,
  S_EMPIRE, S_ITALIANATE, S_CIVIC, S_TERRACOTTA, S_CHICAGO, S_MARKET, S_MODERNE,
  S_LIBRARY, S_BANKTEMPLE, S_HOTEL, S_SCHOOL,
  S_CHURCHSTONE, S_SYNAGOGUE, S_COLLEGIATE, S_BATHHOUSE, S_MUSEUM, S_ARMORY,
];

/** Old enough, and soft enough, to have grown a pitched roof over it. */
export const T_OLDROOF = [
  S_PREWAR, S_BRICK, S_FEDERAL, S_ITALIANATE, S_EMPIRE, S_TENEMENT, S_CARRIAGE,
  S_QUEENANNE, S_STICK, S_TUDOR, S_MISSION,
  S_TRIPLEDECK, S_SHOTGUN, S_GAMBREL, S_FOURSQUARE, S_BUNGALOW, S_RANCH,
  S_BACKTOBACK, S_MEETINGHSE,
];

export const has = (list: readonly number[], s: number) => list.indexOf(s) >= 0;

/**
 * The same membership tests, as GLSL. Generated from the arrays above so the
 * shader cannot drift from the TypeScript — the failure mode this replaces is
 * exactly a threshold that was right when it was written and silently wrong
 * two styles later.
 */
const styleFn = (name: string, ids: readonly number[]): string =>
  `bool ${name}(int s) { return ${ids.map((i) => `s==${i}`).join("||")}; }\n`;

/**
 * Old enough to have turned its window heads. A round arch is a nineteenth
 * century way of carrying a wall over a hole; a 1958 brick slab has a steel
 * lintel and a flat head, and putting an arch on it was the single wrongest
 * thing the old blanket masonry test did.
 */
export const T_ARCHED = [
  S_PREWAR, S_BRICK, S_ROMANESQUE, S_ITALIANATE, S_EMPIRE, S_MARKET,
  S_CARRIAGE, S_CASTIRON, S_POWERHOUSE, S_BREWERY, S_PUMPHOUSE,
  S_FIREHOUSE, S_LIBRARY, S_MISSION, S_SYNAGOGUE, S_CONVENT, S_BATHHOUSE,
];

export const STYLE_SETS_GLSL = /* glsl */ `
${styleFn("isMasonry", T_MASONRY)}${styleFn("isGlassy", T_GLASSY)}${styleFn("isTrade", T_TRADE)}${styleFn("isFloorLine", T_FLOORLINE)}${styleFn("isArched", T_ARCHED)}`;

/**
 * What a PARAPET or a bulkhead on top of this building is made of. A glass
 * tower's parapet is not more glass — it is a metal coping or a stone cap, and
 * drawing it in the wall style put a window grid on a two-foot-high object.
 */
export function modernCap(style: number): number {
  if (has(T_CAPPED_STONE, style)) return S_CORNICE;
  if (has(T_CAPPED_PLAIN, style)) return S_PLAIN;
  return style;
}

/**
 * WHICH BUILDING THIS IS.
 *
 * The old chooser was a ladder of five returns over ten styles, and it had two
 * faults that no amount of new styles would have fixed on their own.
 *
 * The first is that its only randomness was `(year, floors)`. Every building
 * in the city finished in 1978 with twenty floors was assigned the SAME style,
 * because nothing about the building itself entered the hash — so the repeats
 * were not bad luck, they were arithmetic. The BBL goes in now.
 *
 * The second is that it gated on `v.z1`, the top of THIS VOLUME. A wedding
 * cake whose base tier tops out at 38 m and whose shaft reaches 60 m took two
 * different branches of the same ladder, so one building was drawn in two
 * materials with the seam at the setback. Every height test here is on floors,
 * which every volume of a building shares.
 *
 * What it does now is offer the families that could plausibly have been built
 * on this site, in this class, in this decade, at this height, and choose among
 * them. Repeats in a pool are weights. A pool is never empty — the last line
 * of each branch is the family that was always the safe answer for that class.
 */
export function stylePool(v: BuildingVolume): number[] {
  const y = v.y || 1950;
  const f = Math.max(1, v.f || 1);
  const p: number[] = [];
  /**
   * A TOWN HAS ONE MUSEUM.
   *
   * Institutional buildings went into the pools at ordinary weight, which in a
   * pool of a dozen entries is about eight per cent — and measured, that made
   * 7% of the office stock museums and another 7% hospitals. There is no city
   * on earth like that. These types are rare for a reason that has nothing to
   * do with architecture: there are few of them per head of population, and a
   * place gets its second hospital at a hundred thousand people, not at its
   * second office block.
   *
   * So rarity is a gate rather than a weight. `rare(prob, salt, ...)` offers a
   * family to a fraction of the buildings that could otherwise take it, on a
   * hash INDEPENDENT of the one that finally picks from the pool — so a
   * building that fails the roll is not merely outvoted, it is never asked.
   */
  const rare = (prob: number, salt: number, ...styles: number[]) => {
    if (hash01(keyOf(v.b) ^ Math.imul(salt + 1, 0x9e3779b1), 0x51ced1ce) < prob) p.push(...styles);
  };
  const office = v.c === "office" || v.c === "mixed";
  const resi = v.c === "multifamily";
  const shop = v.c === "retail";
  const works = !office && !resi && !shop;   // industrial and everything odd

  // ---- the working waterfront, which does not follow fashion ---------------
  if (works) {
    // WHAT IT IS MAKING DECIDES WHAT IT LOOKS LIKE. A gasholder, a grain
    // elevator, a cold store and a brewery share nothing — they are different
    // shapes holding different things, and the walls follow from the contents.
    // Height and plate stand in for the contents here, because they are what
    // the process actually dictates: a silo is tall and blind, an engine hall
    // is one enormous room, a mill is a grid of identical bays.
    // A SILO HAS NO FLOORS. The generator gives every building a floor count
    // because everything gets one, but a grain elevator is a thirty-metre drum
    // and a gasholder is a tank in a frame — neither has a storey in it. Gating
    // them on floors is gating them on a fiction, and measured it made them
    // unreachable: no industrial building in this town has five floors, and the
    // whole class runs 2 at the quartile and 4 at the ninth decile. So the gate
    // is TALL FOR ITS CLASS, which here is four.
    if (y < 1900) {
      p.push(S_MILL, S_CARRIAGE, S_ROMANESQUE, S_PUMPHOUSE);
      if (f >= 3) p.push(S_TEXTILE, S_TEXTILE, S_BREWERY);
      if (f >= 2) p.push(S_FOUNDRY, S_COLDSTORE, S_DEPOT);
      if (f >= 3) p.push(S_POWERHOUSE, S_GRAINHOUSE, S_GASHOLDER);
      rare(0.34, 20, S_TRAINSHED, S_CARBARN, S_LIGHTHOUSE, S_EXCHANGE);
    } else if (y < 1945) {
      p.push(S_MILL, S_PUMPHOUSE, S_BREWERY, S_DEPOT, S_CARRIAGE);
      if (f >= 3) p.push(S_TEXTILE, S_TEXTILE, S_COLDSTORE);
      if (f >= 2) p.push(S_FOUNDRY, S_FOUNDRY, S_SHIPSHED);
      if (f >= 3) p.push(S_POWERHOUSE, S_POWERHOUSE, S_GRAINHOUSE, S_GRAINHOUSE, S_GASHOLDER, S_GASHOLDER);
      rare(0.36, 21, S_TRAINSHED, S_CARBARN, S_EXCHANGE, S_SUBSTATION, S_HANGAR, S_LIGHTHOUSE);
    } else if (y < 1980) {
      // The tilt-up arrives in the sixties and takes over completely. Low and
      // wide is a shed; anything with a couple of floors is still a frame.
      p.push(S_METALPAN, S_PRECAST, S_SHIPSHED, S_COLDSTORE, S_FOUNDRY);
      if (f <= 2) p.push(S_TILTUP, S_TILTUP, S_QUONSET, S_TRUCKTERM, S_DISTCENTER);
      if (f >= 3) p.push(S_BRUTAL, S_TEXTILE, S_FLEX);
      if (f >= 4) p.push(S_GRAINHOUSE, S_POWERHOUSE, S_GASHOLDER);
      rare(0.34, 22, S_SUBSTATION, S_HANGAR, S_BUSCANOPY, S_CONTROLTWR, S_EXCHANGE);
    } else {
      p.push(S_METALPAN, S_BIGBOX, S_EIFS, S_SHIPSHED);
      if (f <= 2) p.push(S_TILTUP, S_TILTUP, S_TILTUP, S_DISTCENTER, S_DISTCENTER,
        S_TRUCKTERM, S_SELFSTOR, S_QUONSET);
      if (f >= 2) p.push(S_FLEX, S_FLEX, S_SELFSTOR);
      rare(0.30, 23, S_SUBSTATION, S_HANGAR, S_BUSCANOPY, S_CONTROLTWR);
      if (f >= 2) p.push(S_DATACENTER);
      if (f >= 3) p.push(S_COLDSTORE, S_DATACENTER);
    }
    if (f >= 4 && y >= 1955) p.push(S_GARAGE);
    return p;
  }

  // ---- before the elevator, everything is a wall with holes in it ----------
  if (y < 1850) {
    p.push(S_FEDERAL, S_FEDERAL, S_FEDERAL, S_BRICK, S_PREWAR);
    if (shop) p.push(S_FEDERAL, S_ITALIANATE);
    return p;
  }
  if (y < 1885) {
    p.push(S_ITALIANATE, S_ITALIANATE, S_FEDERAL, S_BRICK, S_PREWAR, S_EMPIRE);
    if (!resi && f >= 3) p.push(S_CASTIRON, S_CASTIRON, S_CASTIRON);
    if (f >= 4) p.push(S_EMPIRE, S_ROMANESQUE);
    if (resi) p.push(S_TENEMENT, S_BRICK, S_BACKTOBACK, S_SHOTGUN, S_GAMBREL);
    if (!resi) rare(0.38, 1, S_CHURCHSTONE, S_MEETINGHSE, S_CONVENT, S_CELLBLOCK);
    return p;
  }
  if (y < 1905) {
    p.push(S_ROMANESQUE, S_ITALIANATE, S_PREWAR, S_BRICK);
    // VERNACULAR LAGS FASHION BY A GENERATION, and in a small port it lags by
    // two. New Alden's oldest recorded building is 1885 — the generator makes
    // nothing before it — so the Federal and Second Empire families would be
    // dead code gated to the dates the styles were invented. They are not dead
    // in the world: a carpenter in an 1890s harbour town was still building the
    // house he had been taught to build in 1850, which is the whole reason
    // small-town stock reads as older than its dates.
    p.push(S_FEDERAL, S_EMPIRE);
    if (resi) p.push(S_FEDERAL, S_EMPIRE);
    if (!resi) p.push(S_CASTIRON, S_ROMANESQUE, S_MARKET);
    // GOTHIC AT SMALL SCALE. Terra-cotta Gothic is a tall-office style and this
    // town has two prewar offices over six storeys, so gated there it is worth
    // 0.7 buildings and draws none. It is not only a tall-office style: the
    // same pointed arch built every church, school and parish hall in the
    // nineteenth century, at three storeys, and that is where a port town
    // actually keeps it. The steeple rule reads this style too.
    if (!resi) p.push(S_GOTHIC);
    if (resi) p.push(S_TENEMENT, S_BRICK, S_QUEENANNE, S_STICK);
    if (resi && f <= 4) p.push(S_TRIPLEDECK, S_TRIPLEDECK, S_SHOTGUN, S_BACKTOBACK, S_TWOFLAT);
    if (resi && f >= 4) p.push(S_ORIEL, S_MANSIONBLK, S_SRO);
    if (office && f >= 6) p.push(S_CHICAGO, S_CHICAGO, S_BEAUX);
    if (office && f <= 4) p.push(S_PROFBLDG, S_BOUTIQUEOFF);
    // The buildings a town has one of. They are rare by weight, not by gate —
    // a place has one bank with columns and one firehouse, and both of them
    // are on a corner everybody knows.
    if (resi && f <= 4) p.push(S_QUEENANNE, S_QUEENANNE, S_STICK);
    if (!resi) p.push(S_BANKTEMPLE, S_HOTEL);
    if (!resi) rare(0.42, 2, S_FIREHOUSE, S_LIBRARY, S_SCHOOL,
      S_CHURCHSTONE, S_SYNAGOGUE, S_ARMORY, S_CONVENT, S_CELLBLOCK, S_HOSPITAL, S_MEETINGHSE);
    if (shop && f >= 3) p.push(S_DEPTSTORE);
    if (shop) p.push(S_CORNERRETAIL, S_RESTAURANT);
    return p;
  }
  if (y < 1925) {
    p.push(S_PREWAR, S_BRICK);
    if (!resi) p.push(S_GOTHIC);              // the parish hall, the school
    if (office) p.push(S_BEAUX, S_BEAUX, S_CHICAGO, S_CHICAGO, S_TERRACOTTA);
    // Terra-cotta Gothic on six storeys is the small-city version of the
    // type and there are hundreds of them; gated at eight it lost to the fact
    // that this town has twenty buildings that tall in total.
    if (office && f >= 6) p.push(S_GOTHIC, S_GOTHIC, S_GOTHIC, S_TERRACOTTA);
    if (shop) p.push(S_TERRACOTTA, S_BEAUX, S_CHICAGO, S_MARKET);
    if (resi) p.push(S_TENEMENT, S_TENEMENT, S_BRICK, S_PREWAR, S_BEAUX);
    if (resi && f <= 4) p.push(S_QUEENANNE, S_TUDOR, S_MISSION,
      S_TRIPLEDECK, S_FOURSQUARE, S_FOURSQUARE, S_BUNGALOW, S_BUNGALOW, S_TWOFLAT, S_GAMBREL);
    if (resi && f >= 4) p.push(S_ORIEL, S_ORIEL, S_MANSIONBLK, S_SRO, S_SRO);
    if (!resi && f <= 3) p.push(S_CARRIAGE, S_CARRIAGE);
    if (!resi) p.push(S_BANKTEMPLE, S_HOTEL, S_THEATRE);
    if (!resi) rare(0.42, 3, S_FIREHOUSE, S_LIBRARY, S_SCHOOL,
      S_CHURCHSTONE, S_SYNAGOGUE, S_COLLEGIATE, S_BATHHOUSE, S_MUSEUM, S_HOSPITAL, S_ARMORY);
    if (shop && f >= 3) p.push(S_DEPTSTORE, S_DEPTSTORE);
    if (shop) p.push(S_CORNERRETAIL, S_CORNERRETAIL, S_RESTAURANT, S_BANKBRANCH);
    return p;
  }
  if (y < 1945) {
    // The deco decades. Height decides whether a building got the tower
    // treatment or the low, wide, horizontal one.
    if (f >= 7) p.push(S_ARTDECO, S_ARTDECO, S_ARTDECO, S_GOTHIC, S_TERRACOTTA);
    else p.push(S_MODERNE, S_MODERNE, S_ARTDECO, S_TERRACOTTA);
    p.push(S_CIVIC, S_PREWAR, S_BRICK);
    if (resi) p.push(S_BRICK, S_PREWAR, S_TENEMENT, S_TUDOR, S_MISSION);
    if (shop) p.push(S_MODERNE, S_TERRACOTTA, S_DEPTSTORE, S_CORNERRETAIL,
      S_RESTAURANT, S_BANKBRANCH, S_SHOWROOM, S_GROCERY);
    if (resi && f <= 4) p.push(S_TUDOR, S_MISSION, S_BUNGALOW, S_FOURSQUARE, S_GAMBREL);
    if (resi && f >= 4) p.push(S_MANSIONBLK, S_ORIEL, S_SRO);
    if (!resi) p.push(S_THEATRE, S_HOTEL);
    if (!resi) rare(0.42, 4, S_SCHOOL, S_LIBRARY, S_FIREHOUSE,
      S_COLLEGIATE, S_BATHHOUSE, S_MUSEUM, S_HOSPITAL, S_CHURCHSTONE);
    return p;
  }
  if (y < 1962) {
    p.push(S_RIBBON, S_RIBBON, S_BRICK, S_PROJECT, S_CIVIC);
    if (office && f >= 6) p.push(S_INTL, S_INTL, S_RIBBON, S_INSURANCE, S_SKYLOBBY);
    if (office && f <= 4) p.push(S_PROFBLDG, S_PROFBLDG, S_GARDENOFF, S_MEDOFFICE, S_GOVLEASE);
    if (office) p.push(S_BACKOFFICE, S_CAMPUSBLOCK);
    if (resi) p.push(S_PROJECT, S_PROJECT, S_WHITEBRICK, S_WHITEBRICK, S_WHITEBRICK);
    if (shop) p.push(S_MODERNE, S_RIBBON, S_EIFS, S_DINER, S_STRIPMALL,
      S_GROCERY, S_GROCERY, S_SHOWROOM, S_RESTAURANT, S_BANKBRANCH, S_FASTFOOD, S_PHARMACY);
    if (!resi) p.push(S_THEATRE, S_HOTEL);
    if (!resi) rare(0.40, 5, S_SCHOOL, S_COLLEGIATE, S_MUSEUM, S_HOSPITAL);
    if (resi && f <= 3) p.push(S_MOTEL, S_RANCH, S_RANCH, S_RANCH, S_GARDENAPT, S_GARDENAPT);
    return p;
  }
  if (y < 1980) {
    p.push(S_RIBBON, S_PRECAST, S_BRUTAL, S_PROJECT);
    if (office && f >= 6) p.push(S_INTL, S_PRECAST, S_PRECAST, S_MIRROR, S_BRUTAL, S_INSURANCE, S_INSURANCE, S_SKYLOBBY);
    if (office && f <= 4) p.push(S_OFFICEPARK, S_OFFICEPARK, S_PROFBLDG, S_MEDOFFICE, S_MEDOFFICE, S_GARDENOFF, S_GOVLEASE);
    if (office) p.push(S_BACKOFFICE, S_CAMPUSBLOCK, S_CARRIERHTL);
    if (office && f >= 9) p.push(S_MIRROR, S_MIRROR, S_DARK);
    if (resi) p.push(S_WHITEBRICK, S_WHITEBRICK, S_PROJECT, S_PRECAST, S_BRICK);
    if (shop) p.push(S_EIFS, S_PRECAST, S_METALPAN, S_STRIPMALL, S_DINER,
      S_GROCERY, S_JRBOX, S_JRBOX, S_FASTFOOD, S_FASTFOOD, S_BANKBRANCH, S_PHARMACY,
      S_AUTOPARTS, S_SHOWROOM, S_RESTAURANT, S_MALLANCHOR);
    if (!resi) p.push(S_HOTEL);
    if (!resi) rare(0.40, 6, S_SCHOOL, S_MUSEUM, S_HOSPITAL);
    if (resi && f <= 3) p.push(S_MOTEL, S_RANCH, S_RANCH, S_GARDENAPT, S_GARDENAPT, S_GARDENAPT);
    if (f >= 4) p.push(S_GARAGE);
    return p;
  }
  if (y < 1998) {
    p.push(S_EIFS, S_GLASS, S_PMOD, S_BRICK);
    if (office && f >= 6) p.push(S_PMOD, S_PMOD, S_MIRROR, S_GLASS, S_DARK, S_DEEPFRAME, S_SKYLOBBY);
    if (office && f <= 4) p.push(S_OFFICEPARK, S_OFFICEPARK, S_MEDOFFICE, S_MEDOFFICE, S_PROFBLDG, S_BTSHQ, S_GOVLEASE);
    if (office) p.push(S_BACKOFFICE, S_CAMPUSBLOCK, S_CARRIERHTL, S_LOFTOFFICE);
    if (office && f >= 10) p.push(S_PMOD, S_DARK);
    if (resi) p.push(S_EIFS, S_WHITEBRICK, S_BALCONY, S_BALCONY, S_PODIUMWRAP);
    if (office && f >= 4) p.push(S_LABBLDG, S_CREATIVE, S_BTSHQ);
    if (shop) p.push(S_EIFS, S_BIGBOX, S_METALPAN, S_STRIPMALL, S_TILTUP,
      S_JRBOX, S_JRBOX, S_POWERINLINE, S_POWERINLINE, S_FASTFOOD, S_PHARMACY, S_PHARMACY,
      S_AUTOPARTS, S_BANKBRANCH, S_GROCERY, S_OUTLET, S_MALLANCHOR, S_RESTAURANT);
    if (!resi) p.push(S_HOTEL);
    if (!resi) rare(0.40, 7, S_SCHOOL, S_MUSEUM, S_HOSPITAL);
    if (resi && f <= 3) p.push(S_MOTEL, S_RANCH, S_GARDENAPT, S_GARDENAPT);
    if (f >= 4) p.push(S_GARAGE);
    return p;
  }
  if (y < 2012) {
    p.push(S_GLASS, S_EIFS, S_BRICK);
    if (office && f >= 6) p.push(S_CRYSTAL, S_GLASS, S_FRIT, S_SCREEN, S_DARK,
      S_UNITGLASS, S_UNITGLASS, S_DEEPFRAME, S_MEGAPANEL,
      S_PLEATED, S_SHINGLED, S_DOUBLESKIN, S_CHEVRON, S_LABBLDG, S_CREATIVE);
    if (office && f >= 12) p.push(S_MEGABRACE, S_PLEATED, S_DOUBLESKIN);
    if (resi) p.push(S_PODIUMWRAP, S_PODIUMWRAP, S_MICROUNIT);
    if (!resi) p.push(S_MEDIAFACE);
    if (office && f >= 14) p.push(S_TERRAPIER, S_MEGAPANEL);
    if (office && f >= 20) p.push(S_DIAGRID, S_CRYSTAL);
    if (resi) p.push(S_BALCONY, S_BALCONY, S_GLASS, S_EIFS, S_BRICK);
    if (resi && f >= 8) p.push(S_BALCONY, S_CRYSTAL);
    if (shop) p.push(S_EIFS, S_BIGBOX, S_SCREEN, S_TILTUP, S_SELFSTOR,
      S_POWERINLINE, S_JRBOX, S_LIFESTYLE, S_LIFESTYLE, S_FASTFOOD, S_PHARMACY,
      S_AUTOPARTS, S_GROCERY, S_RESTAURANT, S_CORNERRETAIL, S_OUTLET);
    if (f >= 4) p.push(S_GARAGE);
    return p;
  }
  // the present, which builds thinner walls and warmer ones at the same time
  p.push(S_CRYSTAL, S_FRIT, S_SCREEN, S_TIMBER);
  if (office && f >= 6) p.push(S_CRYSTAL, S_FRIT, S_SCREEN, S_TIMBER,
    S_UNITGLASS, S_TERRAPIER, S_TERRAPIER, S_MEGAPANEL, S_STEELSHELF,
    S_PLEATED, S_PLEATED, S_SHINGLED, S_DOUBLESKIN, S_CHEVRON, S_PVCLAD,
    S_LABBLDG, S_LABBLDG, S_CREATIVE, S_SKYGARDEN);
  if (office && f >= 12) p.push(S_MEGABRACE, S_SKYGARDEN, S_PVCLAD, S_DOUBLESKIN);
  if (!resi) p.push(S_MEDIAFACE, S_CREATIVE);
  if (office && f >= 14) p.push(S_TERRAPIER, S_STEELSHELF, S_DEEPFRAME);
  if (office && f >= 20) p.push(S_DIAGRID, S_CRYSTAL, S_DARK);
  if (resi) p.push(S_BALCONY, S_BALCONY, S_SCREEN, S_TIMBER, S_FRIT, S_BRICK,
    S_PODIUMWRAP, S_PODIUMWRAP, S_MICROUNIT, S_PASSIVE, S_MODULAR);
  if (resi && f >= 10) p.push(S_SKYGARDEN, S_SKYGARDEN, S_MODULAR, S_PLEATED);
  if (shop) p.push(S_SCREEN, S_TIMBER, S_BIGBOX, S_EIFS, S_TILTUP,
    S_LIFESTYLE, S_LIFESTYLE, S_POWERINLINE, S_JRBOX, S_FASTFOOD, S_PHARMACY,
    S_GROCERY, S_RESTAURANT, S_CORNERRETAIL, S_SHOWROOM);
  if (f >= 4) p.push(S_GARAGE);
  return p;
}

export function styleFor(v: BuildingVolume): number {
  if (v.d) return S_PLAIN;
  // The BUILDING, not just its year and its height — see stylePool. Keying on
  // the deed is what stops two towers finished the same year being twins.
  const pool = stylePool(v);
  return pick(pool, v);
}

/** The chooser both entry points share, so they cannot drift apart. */
function pick(pool: number[], v: BuildingVolume): number {
  const h = hash01(keyOf(v.b) ^ 0x5f3a91c7, ((v.y | 0) * 2654435761) >>> 0);
  return pool[Math.min(pool.length - 1, Math.floor(h * pool.length))];
}

/**
 * NOT EVERY BUILDING IN A CITY IS A BUILDING SOMEBODY DEVELOPED.
 *
 * These four are in the pools because a town HAS them and they have to be
 * drawn — but none of them is a lettable asset, and none of them is a thing a
 * developer builds and holds. A parking deck has no leasable floor in it at
 * all; a substation, a bus canopy and a control tower are infrastructure that
 * arrives with a utility or an airfield rather than with a capital stack.
 *
 * The distinction only matters on the built-to-order path, where the class is
 * something the player chose and underwrote. The generator keeps all four:
 * that is the difference between "what stands here" and "what was developed".
 */
const NOT_BUILT_TO_ORDER = new Set([S_GARAGE, S_SUBSTATION, S_BUSCANOPY, S_CONTROLTWR]);

/**
 * WHAT A BUILDING SOMEBODY JUST FINISHED WEARS.
 *
 * The renderer has two paths that make buildings and only one of them was
 * asking this file. `setPlayerBuildings` — everything the player and the
 * rivals put up, which after twenty years is most of downtown — carried its
 * own ladder of six hard-coded ids, and three of the six were era-wrong for a
 * building finished this month: new retail came out as mid-century ribbon
 * windows, new industrial as nineteenth-century mill sash, and one office in
 * seven as 1920s deco piers. A hundred and forty-four families existed and the
 * half of the city the player is responsible for could reach six of them.
 *
 * So it asks the same chooser the stock does, on the same inputs, minus the
 * families above. Same class, same year, same floors, same deed hash — which
 * means a tower the player finishes in 2014 is drawn by the rules that would
 * have drawn it had the generator put it there in 2014, and the two
 * populations stop being distinguishable by eye. That was the whole point of
 * `styles.ts` being its own file; half the city was not using it.
 */
export function styleForBuilt(v: BuildingVolume): number {
  if (v.d) return S_PLAIN;
  const pool = stylePool(v).filter((s) => !NOT_BUILT_TO_ORDER.has(s));
  // A pool is never empty, but a filtered one could be — fall back rather than
  // return undefined and paint the whole building flat grey.
  return pool.length ? pick(pool, v) : styleFor(v);
}
