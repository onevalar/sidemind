/** Every sample area for the explorer's area switch, in the order the switch lists them. */

import { unitedStatesMap, type ChoroplethMap } from "./choropleth-explorer-data";
import { canadaMap } from "./choropleth-explorer-canada";
import { brazilMap } from "./choropleth-explorer-brazil";
import { unitedKingdomMap } from "./choropleth-explorer-united-kingdom";
import { franceMap } from "./choropleth-explorer-france";
import { germanyMap } from "./choropleth-explorer-germany";
import { italyMap } from "./choropleth-explorer-italy";
import { australiaMap } from "./choropleth-explorer-australia";

export const choroplethMaps: ChoroplethMap[] = [unitedStatesMap, canadaMap, brazilMap, unitedKingdomMap, franceMap, germanyMap, italyMap, australiaMap];
