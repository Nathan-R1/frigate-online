var CREW_PRESETS = [
    {name:'Ambassador Kamar', type:'science', text_description:'You have the legal right to travel into People’s Star space.<b><c>Diplomacy</c></b>', combat_only:false},
    {name:'Arc Agent Tha’n', type:'science', text_description:'You have the legal right to travel into Vedlu space. <b><c>Leadership<c></b>', combat_only:false},
    {name:'Captain Janson', type:'science', text_description:'If you are scanned, you are notified and can respond with any known ship design.<b><c>Sensors</c></b>', combat_only:false},
    {name:'Citadel', type:'defense', text_description:'You begin combat with 2 Core modules. Core modules gain "Req.: Adjacent to Core" and share your Hull HP.', combat_only:true},
     {name:'Co-leadership', type:'science', text_description:'At the start of your turn if you succeed a DC 12 Leadership Check you gain 1 Energy (this may exceed your Max Energy).', combat_only:true},
    {name:'Conservative', type:'defense', text_description:'At the start of your turn, if you did not activate any “Offense” technologies, modules or deployables last round, gain 2 shields.', combat_only:true},
     {name:'Hoarding', type:'science', text_description:'+4 Storage', combat_only:false},
     {name:'Heat Sinks', type:'movement', text_description:'When you roll an attack, add one Heat here or to any ability that can take Heat. When you Move, discard any Heat here, gain 1 Move per 2 Heat discarded.', combat_only:true},
    {name:'Jamming', type:'science', text_description:'When you Create Deployables, you may put them aside instead of on the board. They cannot activate or be targetted and do not occupy a particular space. At the start of your next turn, place them on the board following their normal Creation rules.', combat_only:true},
    {name:'Crew Munitions Assignment', type:'offense', text_description:'When you add 1 or more charges to a Technology, Module or Deployable you may add 1 additional. Take 1 penalty to any Crew Skill.', combat_only:true},
     {name:'Motherly', type:'defense', text_description:'When an allied ship within Sensor range takes Hull damage, you may reduce it by 1 and take 1 Hull HP damage to your Core Module.', combat_only:true},
     {name:'Peace Loving', type:'science', text_description:'When you fail a Diplomacy check that would initiate combat, you may reroll once.', combat_only:false},
     {name:'Scrappy', type:'defense', text_description:'Once per round, when you take Hull damage, you may make an Engineering Save against the enemy’s DC to take 1 less Hull HP damage.', combat_only:true},
     {name:'Sir Athruul', type:'movement', text_description:'After you complete your Move, you may Move 1 any asteroids which your Modules passed adjacent to.', combat_only:true},
         {name:'The Sky Walker', type:'movement', text_description:'+1 Navigation\n\nChecks for piloting and navigation are made with advantage. <b><c>Navigation</c></b>', combat_only:true},
         {name:'Watchful', type:'science', text_description:'Sensor range is calculated by 2 x Sensors plus Cyber', combat_only:true},
    {name:'Zealots', type:'science', text_description:'Expedition penalties are ignored. When you would receive any type of Crew Penalty gain an Inspiration.', combat_only:false},
    {name:'Fire-Control Director', type:'offense', combat_only:true, text_description:'Gain +1 range on all weapons'},
    {name:'Charge Battery', type:'science', combat_only:true, text_description:'The first time you add Charge to a Technology, Module or Deployable this combat, add 2 extra.'},
    {name:'Advancement', type:'science', combat_only:false, text_description:'+1 DC'},
    {name:'Energy Conduit', type:'science', combat_only:true, text_description:'At the end of your turn, if you have at least 1 Energy remaining, an ally within Sensor range gains +1 Energy on their next turn (this may exceed their Energy max).'}
  ];
CREW_PRESETS.sort(function(a,b){return a.name.toLowerCase().localeCompare(b.name.toLowerCase());});
