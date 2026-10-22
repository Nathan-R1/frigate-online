/* Machine-readable behaviour for every tech and module, keyed by the name in
   tech-presets.js / mod-presets.js. The presets stay the single source of DISPLAY text;
   this file is the single source of BEHAVIOUR. validate-effects.js checks the two agree.

   Shape:
     onPlay:   [op, ...]                 resolved when the card is played
     activate: { cost:[op], effect:[op] } an On Activate ability; cost is paid first
     passive:  [{ trigger, effect:[op], optional }]
     placement: for modules — where they may be built
   Any op field may be the string 'choose', which raises a prompt. */
var CARD_EFFECTS = {

/* ============================ TECHS ============================ */
tech: {

/* --- module creators: play, spawn, trash --- */
'Cannon Unit':            { onPlay:[{op:'createModule',module:'Cannon'},{op:'trashSelf'}] },
'P.D. Unit':              { onPlay:[{op:'createModule',module:'P.D.'},{op:'trashSelf'}] },
'Armor Unit':             { onPlay:[{op:'createModule',module:'Armor'},{op:'trashSelf'}] },
'DEW Unit':               { onPlay:[{op:'createModule',module:'Directed Laser Beam'},{op:'trashSelf'}] },
'Graviton Unit':          { onPlay:[{op:'createModule',module:'Graviton Engine'},{op:'trashSelf'}] },
'Thrust Unit':            { onPlay:[{op:'createModule',module:'Thrust Engine'},{op:'trashSelf'}] },
'Comms Unit':             { onPlay:[{op:'createModule',module:'Comms Unit'},{op:'trashSelf'}] },
'Shield Unit':            { onPlay:[{op:'createModule',module:'Shield Connector'},{op:'trashSelf'}] },
'SPEAR Unit':             { onPlay:[{op:'createModule',module:'SPEAR Connector'},{op:'trashSelf'}] },
'Repulsor Unit':          { onPlay:[{op:'createModule',module:'Repulsor Unit'},
                                    {op:'trashSelf'}] },
'Quantum Disrupter Unit': { onPlay:[{op:'createModule',module:'Quantum Disrupter'},
                                    {op:'trashSelf'}] },
'Citadel':                { onPlay:[{op:'gainHull',n:5,mayExceed:true,target:'core'},
                                    {op:'createModule',module:'Citadel'},{op:'trashSelf'}] },

/* --- charge banks that spawn deployables / modules --- */
'Torpedo Launcher':       { onPlay:[{op:'addCharge',target:'self',n:4}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'createDeployable',deployable:'Ion Torpedo'}] } },
'Fusion Mine Launcher':   { onPlay:[{op:'addCharge',target:'self',n:2}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'createDeployable',deployable:'Fusion Mine'}] } },
'TAT Launcher':           { onPlay:[{op:'addCharge',target:'self',n:1}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'createDeployable',deployable:'TAT Guided'}] } },
'Cloak':                  { onPlay:[{op:'cloak',target:'choose'},{op:'trashSelf'}] },
'Decoy Launcher':         { activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'createDeployable',deployable:'Decoy Deployable'}] } },
'Decoy Builder':          { onPlay:[{op:'addCharge',target:'self',n:4}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'createModule',module:'Decoy Module'}] } },

/* --- direct-fire weapons --- */
'Rocket Array':           { onPlay:[{op:'addCharge',target:'self',n:1},{op:'exhaustSelf'}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'attack',range:9,from:'any',attacks:8,dmg:1}] } },
'Mag Bomb Array':         { onPlay:[{op:'addCharge',target:'self',n:2},{op:'exhaustSelf'}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'attack',range:4,from:'offenseModule',attacks:3,dmg:1,
                                                dmgType:'kinetic',chainOnHullHit:true}] } },
'Asteroid Lance':         { activate:{ cost:[{op:'exhaustSelf'},{op:'consumeAsteroid',within:'sensors'}],
                                       effect:[{op:'attack',range:'sensors',from:'any',attacks:1,dmg:3,
                                                check:'Sensors',dmgType:'kinetic'}] } },
'Burning Wave':           { activate:{ mode:'choice', options:[
                              { label:'Add 3 Heat', cost:[{op:'exhaustSelf'}],
                                effect:[{op:'addHeat',target:'self',n:3}] },
                              { label:'Fire', cost:[{op:'exhaustSelf'},{op:'spendAllHeat'}],
                                effect:[{op:'attack',range:1,from:'any',attacks:'heatSpent',dmg:1,
                                         dmgType:'kinetic'}] } ] } },
'Target Locking':         { passive:[{ trigger:'onDealDamage',
                                       effect:[{op:'addCharge',target:'self',n:1,resetOnNewTarget:true}] }],
                            activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'attack',range:'sensors',from:'any',
                                                attacks:'charges',dmg:1,target:'locked'}] } },
'Fire Shield':            { passive:[{ trigger:'onShieldDamaged',
                                       effect:[{op:'addHeat',target:'self',n:1}] }],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendHeat',n:'upTo4'}],
                                       effect:[{op:'attack',range:'sensors',from:'any',aoe:'allObjects',
                                                attacks:'heatSpent',dmg:1,dmgType:'energy'}] } },

/* --- control / utility attacks --- */
/* `anim` on an attack names how the board draws it (client/game/attack-fx.js). Left out, the
   look follows the damage type; these two do no damage, and a beam that takes hold of its
   target reads as one rather than as a shell bursting. */
/* a beam, not a gun: it may take hold of anything it can see, friendly hull included */
'Tract Beam':             { activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'attack',range:'sensors',from:'offenseModule',
                                                attacks:1,dmg:0,check:'Cyber',targets:'any',anim:'tractor',
                                                onSuccess:[{op:'moveObject',what:'target',n:2}]}] } },
'Unwinder Array':         { onPlay:[{op:'addCharge',target:'self',n:4},{op:'exhaustSelf'}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'attack',range:'sensors',from:'any',attacks:1,dmg:0,
                                                check:'Cyber',anim:'tractor',
                                                onSuccess:[{op:'applyStatus',status:'noMove',
                                                            duration:'startOfYourNextTurn',target:'target'}]}] } },

/* --- movement --- */
'Swap Jet':               { activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'swap',n:2}] } },
'Grav Jet':               { activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'gainMove',from:'stat',stat:'speed'}] } },
'Rotating Jet':           { activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'moveObject',what:'ownModule',n:'any',
                                                placement:'adjacentToOwnModule'}] } },
'Recycle Jet':            { activate:{ cost:[{op:'exhaustSelf'},
                                             {op:'spendToken',token:'heatOrCharge',n:1,from:'anyOwnCard'}],
                                       effect:[{op:'moveObject',what:'ownModule',n:4}] } },
'After Burner':           { passive:[{ trigger:'onMove', optional:true,
                                       effect:[{op:'spendHeat',n:1,target:'self'},{op:'gainMove',n:1}] }],
                            activate:{ cost:[{op:'exhaustSelf'}],
                                       effect:[{op:'addHeat',target:'choose',n:1,filter:'takesHeat'}] } },
'Cosmic Shepherd':        { passive:[{ trigger:'onMove', optional:true,
                                       effect:[{op:'moveAsteroids',adjacentTo:'ownModules',n:'sameAsMove'}] }] },
'AI Piloting':            { passive:[{ trigger:'static',
                                       effect:[{op:'allowMoveOntoAsteroid'},
                                               {op:'destroyIfEndTurnOnAsteroid'}] }] },

/* --- defence / reaction --- */
'Reactive Armor':         { passive:[{ trigger:'static', effect:[{op:'negateHullDamageOnce'}] }] },
/* Reactions that land on somebody else's turn are rules the engine applies where they bite —
   Chaff Clouds and Phantom inside the attack, Reactive Armor where hull is lost — because
   nobody can be asked mid-attack whose turn it is not. */
'Chaff Clouds':           { passive:[{ trigger:'static', effect:[{op:'shrugDeployableCheck'}] }] },
'Phantom':                { passive:[{ trigger:'static', effect:[{op:'phantomDodge'}] }] },
'Shield Generator':       { activate:{ mode:'choice', options:[
                              { label:'Charge', cost:[{op:'exhaustSelf'}],
                                effect:[{op:'addCharge',target:'self',n:1}] },
                              { label:'Shield', cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                effect:[{op:'gainShield',n:2}] } ] } },
'Hardening Array':        { onPlay:[{op:'addCharge',target:'self',n:'2xEngineering'}],
                            activate:{ cost:[{op:'exhaustSelf'},{op:'spendCharge',n:1}],
                                       effect:[{op:'gainHull',n:1,mayExceed:true,
                                                target:'choose',filter:'moduleWithinSensors'}] } },

/* --- deck manipulation --- */
'Boost':                  { onPlay:[{op:'grantPlays',n:2},{op:'discardSelf'}] },
'Dynamo':                 { onPlay:[{op:'draw',n:2},{op:'grantPlays',n:1},{op:'discardSelf'}] },
'Heat Stores':            { onPlay:[{op:'addHeat',target:'allOwnCards',filter:'takesHeat',n:1},
                                    {op:'discardSelf'}] },
'Heat Sinks':             { passive:[
                              { trigger:'onFailCheck', optional:true, ownTurn:true,
                                effect:[{op:'spendHeat',n:2,target:'self'},{op:'reroll',n:1}] },
                              { trigger:'onExhaustMovementModule', ownTurn:true,
                                effect:[{op:'addHeat',target:'choose',n:1,filter:'takesHeat'}] }] },
'Revitaliser':            { onPlay:[{op:'recoverFromTrash',exhaust:2},{op:'discardSelf'}] },
'Vital Burst':            { onPlay:[{op:'chooseCard',filter:'ownCardInPlayWithActivate',as:'t'},
                                    {op:'activateCard',ref:'t',times:2,payCosts:true},
                                    {op:'trashCard',ref:'t',keepFixedDurations:true},
                                    {op:'discardSelf'}] },

/* --- buffs / board --- */
'Overcharge':             { activate:{ cost:[{op:'exhaustSelf'},
                                             {op:'exhaustOther',filter:'movementModule',n:1}],
                                       effect:[{op:'buff',scope:'modules',filter:'cannonOrPD',
                                                dmg:1,range:2,
                                                duration:'startOfYourNextTurn'}] } },
'Full Volley':            { activate:{ cost:[],
                                       effect:[{op:'refresh',filter:'exhaustedOffenseModule',n:'all'},
                                               {op:'trashSelf'}] } },
'Divert Power':           { onPlay:[{op:'addToken',token:'Power',target:'choose',filter:'ownModule'}],
                            passive:[{ trigger:'static',
                                       effect:[{op:'buff',scope:'modules',filter:'hasPowerToken',
                                                hull:1,move:1,range:1,dmg:1}] }] },
'Decomp Strikes':         { passive:[{ trigger:'onAttackRoll', optional:true,
                                       condition:'attackerAdjacentToTerrain',
                                       effect:[{op:'reroll',n:1,scope:'missedAttacks'}] }] },
'Asteroid Builder':       { activate:{ mode:'choice', options:[
                              { label:'Charge', cost:[{op:'exhaustSelf'}],
                                effect:[{op:'addCharge',target:'self',n:2}] },
                              { label:'Build', cost:[{op:'exhaustSelf'},{op:'spendCharge',n:2}],
                                effect:[{op:'createAsteroid',n:1,at:'choose'}] } ] } },
'Debris Field':           { onPlay:[{op:'createAsteroid',n:1,at:'choose',within:'sensors',
                                     pattern:'selfAndAllAdjacent'},
                                    {op:'trashSelf'}] },
'SU Scanners':            { activate:{ cost:[{op:'exhaustSelf'}],
                                        effect:[{op:'revealStealth',within:'sensors'}] } },

/* --- tutorial aids: not rules, floating prompts -------------------------
   Each listens for one moment in the player's own game, floats its words over the board, then
   takes itself out of play so it can never prompt twice — a card that has left play is never
   offered another event, so that is all the bookkeeping there is. `at` names the element the
   bubble points at (none means the centre of the screen); `side` is which side of it.

   Moving speaks twice: as the first Move is granted (onMove, before the move prompt opens) it
   explains how the ship moves, and when that move is done it points at End Turn and leaves.

   Enemy Moves answers the player's own first handover and swings the camera across to the
   computer as it begins to move. Play a Card is dealt to the computer instead: it answers the
   computer ending turn 1, so the turn-2 kit (Cannon Unit and P.D. Unit) is in both decks before
   the player's new hand is drawn. Both swing the camera to whoever is now at the controls: the
   computer as turn 1 hands over, then back to the player as turn 2 begins.

   The weapon tips cover both of the kit's guns, whichever is fired first. */
'Tutorial Prompt — Cards':       { passive:[{ trigger:'onPlayPhase', effect:[
    {op:'popup', title:'Click to Begin'},
    {op:'popup', title:'Cards', text:'Click Play to place cards from your hand into play.',
     at:'hand', side:'above'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Modules':     { passive:[{ trigger:'onActionPhase', effect:[
    {op:'popup', title:'Modules',
     text:'Modules in-play can be reused every turn. Click Activate to use a module.',
     at:'hand', side:'above'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Moving':      { passive:[
  { trigger:'onMove', effect:[
    {op:'popup', title:'Moving',
     text:'Your whole ship moves with its Core. Click a highlighted square to take the Core there.\n' +
          'Red squares are blocked: some part of your hull would hit something on the way.'}] },
  { trigger:'onMoveDone', effect:[
    {op:'popup', title:'End Your Turn', text:'Now press End Turn to hand over to your opponent.',
     at:'endBtn', side:'below'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Enemy Moves': { passive:[{ trigger:'onEndTurn', match:{turn:1}, effect:[
    {op:'popup', title:'Enemy Moves', focus:true,
     text:'Keep an eye on how your enemy uses their modules to try and identify them.'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Play a Card': { passive:[{ trigger:'onEndTurn', match:{turn:1}, effect:[
    {op:'addCardsToDeck', cards:['Cannon Unit','P.D. Unit']},
    {op:'popup', title:'Play a card', focus:true, text:'You can only play 1 card each play phase so choose wisely.',
     at:'hand', side:'above'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Aim':         { passive:[{ trigger:'onAim',
                                              match:{weapon:['Cannon','P.D.'], inRange:true}, effect:[
    {op:'popup', title:'Choose a target', text:'Select a gold highlighted square to fire at it.'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — No Targets':  { passive:[{ trigger:'onAim',
                                              match:{weapon:['Cannon','P.D.'], inRange:false}, effect:[
    {op:'popup', title:'No targets in range', text:'Try again when you are closer to the enemy.'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Great Shot':  { passive:[{ trigger:'onHit',
                                              match:{weapon:['Cannon','P.D.'], foe:true}, effect:[
    {op:'popup', title:'Great Shot!',
     text:'Congrats you have attacked the enemy! See their shields and life here.',
     at:'barRow', side:'below'},
    {op:'trashSelf'}] }] },
'Tutorial Prompt — Damage Taken':{ passive:[{ trigger:'onAttacked', match:{foe:true}, effect:[
    {op:'popup', title:'Damage Taken', text:'You were attacked',
     at:'barRow', side:'below'},
    {op:'trashSelf'}] }] }
},

/* =========================== MODULES =========================== */
mod: {

'Core':               { placement:'start', core:true,
                        passive:[{ trigger:'static', effect:[{op:'shareHullWithCoreModules'}] }] },
'Citadel':            { placement:'adjacentToCore',
                        passive:[{ trigger:'static',
                                   effect:[{op:'shareHullWithCore'},{op:'countsAsCore'}] }] },
'Armor':              { placement:'adjacentToAny',
                        passive:[{ trigger:'static', effect:[{op:'noCoreDamageOnDestroy'}] }] },
'Cannon':             { placement:'adjacentToCore',
                        activate:{ cost:[{op:'exhaustSelf'}],
                                   effect:[{op:'attack',range:6,from:'self',attacks:2,dmg:2,
                                            dmgType:'kinetic'}] } },
/* The passive is not declared here any more. It has to answer in the middle of an attack being
   resolved, and the passive queue only runs between actions — which is why this one never once
   fired. It lives in shoot(), as pointDefenceCovers(). */
'P.D.':               { placement:'adjacentToCore',
                        activate:{ cost:[{op:'exhaustSelf'}],
                                   effect:[{op:'attack',range:2,from:'self',attacks:3,dmg:2,
                                            dmgType:'kinetic'}] } },
'Directed Laser Beam':{ placement:'adjacentToCore',
                        activate:{ cost:[{op:'exhaustSelf'}],
                                   effect:[{op:'attack',range:'any',from:'self',attacks:1,dmg:2,
                                            dmgType:'energy',dmgIfRangeAtLeast:{range:10,dmg:4}}] } },
'Quantum Disrupter':  { placement:'adjacentToCore',
                        /* It is a Weapon Module itself, so it is one of the three it needs —
                           asking for three OTHERS means a small ship can never fire it at all. */
                        activate:{ cost:[{op:'exhaustOther',filter:'offenseModule',n:3,
                                          includeSelf:true}],
                                   /* bio damage, but it fires like the energy weapon it is */
                                   effect:[{op:'attack',range:12,from:'self',attacks:1,dmg:6,
                                            check:'Sensors',dmgType:'bio',anim:'energy'},
                                           {op:'createAnomaly',at:'random',fromSelf:true,minR:0,maxR:11}] } },
'SPEAR Connector':    { placement:'adjacentToAny',
                        activate:{ cost:[{op:'exhaustOther',filter:'offenseModuleAdjacent',n:2}],
                                   effect:[{op:'attack',range:'sensors',from:'self',attacks:4,dmg:2,
                                            dmgType:'energy',
                                            onSuccess:[{op:'applyStatus',status:'exhausted',
                                                    duration:'oneRound',target:'hitModule'}]}] } },
'Shield Connector':   { placement:'adjacentToAny',
                        activate:{ cost:[{op:'exhaustOther',filter:'adjacentModule',n:2}],
                                   effect:[{op:'gainShield',n:2}] } },
'Repulsor Unit':      { placement:'adjacentToAny',
                        activate:{ mode:'choice', options:[
                          { label:'Charge', cost:[{op:'exhaustSelf'}],
                            effect:[{op:'addCharge',target:'self',n:2}] },
                          { label:'Shield ally', cost:[{op:'exhaustSelf'},{op:'spendCharge',n:2}],
                            effect:[{op:'gainShield',n:4,target:'choose',
                                     filter:'alliedShipWithinSensors'}] } ] } },
'Comms Unit':         { placement:'adjacentToAny',
                        passive:[{ trigger:'static',
                                   effect:[{op:'buff',scope:'allies',within:'sensors',
                                            checks:2,saves:2}] }] },
/* Not a mimic of some other module, but a silhouette its owner picks when it is built — and
   picked again for every decoy, so two of them need not look alike. */
'Decoy Module':       { placement:'adjacentToAny', chooseShape:true,
                        passive:[{ trigger:'static', effect:[{op:'noCoreDamageOnDestroy'}] }] },
'Graviton Engine':    { placement:'adjacentToAny', movement:true,
                        activate:{ mode:'choice', options:[
                          { label:'Move', cost:[{op:'exhaustOther',filter:'gravitonModule',n:'all',includeSelf:true}],
                            effect:[{op:'gainMove',n:3}] },
                          { label:'Swap', cost:[{op:'exhaustOther',filter:'gravitonModule',n:'all',includeSelf:true}],
                            effect:[{op:'swap',n:1}] } ] } },
'Thrust Engine':      { placement:'adjacentToAny', movement:true,
                        activate:{ cost:[{op:'exhaustSelf'}],
                                   effect:[{op:'gainMove',n:2}] } },

/* --- deployables --- */
'Ion Torpedo':        { deployable:true, speed:12,
                        onPlay:[{op:'exhaustSelf'}],
                        activate:{ cost:[],
                                   effect:[{op:'moveSelf',n:12,optional:true},
                                           {op:'attack',range:1,from:'self',attacks:1,dmg:3,
                                            check:'Sensors',dmgType:'kinetic',targets:'ships',anim:'torpedo'},
                                           {op:'removeSelf'}] } },
/* It arrives ready rather than spent — it can run the turn it is launched — and it is spent by
   firing rather than by existing. A round that connects is gone, which is what a guided round
   is; one that misses is still out there, exhausted until next turn, and gets another try.
   Without the exhaust it had no limit at all and could fire as many times in a turn as you
   cared to click. */
'TAT Guided':         { deployable:true, speed:4,
                        activate:{ cost:[{op:'exhaustSelf'}],
                                   effect:[{op:'moveSelf',n:4,optional:true},
                                           {op:'attack',range:1,from:'self',attacks:1,dmg:4,
                                            check:'Sensors',dmgType:'kinetic',anim:'torpedo',
                                            onSuccess:[{op:'removeSelf'}]}] } },
'Fusion Mine':        { deployable:true, speed:0,
                        passive:[{ trigger:'onDestroyedOrEnemyEnters',
                                   effect:[{op:'activateSelf'}] }],
                        activate:{ cost:[],
                                   /* A Sensors check, not a gun's roll. `save:` was carried
                                      here for a long time and read by nothing at all, so the
                                      blast was quietly rolling a flat d6. */
                                   effect:[{op:'attack',range:1,from:'self',aoe:'radius',
                                            attacks:1,dmg:'2d6',check:'Sensors',dmgType:'kinetic'},
                                           {op:'removeSelf'}] } },
'Decoy Deployable':   { deployable:true, speed:0,
                        passive:[{ trigger:'static', effect:[{op:'stealthMimic',as:'deployable'}] }] }
}
};
