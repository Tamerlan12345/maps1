class RiskEngine {
    constructor() {
        // Almaty and South Kazakhstan (UKO) approximate bounding boxes
        this.seismicZones = [
            { name: 'Almaty', minLat: 43.0, maxLat: 43.4, minLon: 76.7, maxLon: 77.1 },
            { name: 'South KZ', minLat: 41.0, maxLat: 46.0, minLon: 67.0, maxLon: 71.0 } // rough approx
        ];

        // MSK-64 Factors
        this.MSK_FACTORS = {
            6: 0.05,
            7: 0.10,
            8: 0.20,
            9: 0.50,
            10: 1.00
        };

        // Extended Risk Configuration
        this.WEIGHTS = {
            seismic: 0.35,
            flood: 0.15,
            fire: 0.20,
            wind: 0.10,
            hail: 0.05,
            manMade: 0.10,
            social: 0.05
        };

        // Base Annual Probabilities (for PML)
        this.BASE_PROBS = {
            seismic: 0.02,
            flood: 0.05,
            fire: 0.04,
            wind: 0.10,
            hail: 0.20,
            manMade: 0.01,
            social: 0.01
        };
    }

    // --- Helpers ---

    getSeasonalityFactor(month, riskType) {
        // month is 0-11
        if (riskType === 'flood') {
            // Spring (March-May)
            if (month >= 2 && month <= 4) return 2.0;
            return 0.5;
        }
        if (riskType === 'fire') {
            // Summer (June-Sept)
            if (month >= 5 && month <= 8) return 2.5;
            return 0.2;
        }
        if (riskType === 'hail') {
            // Summer (May-August)
            if (month >= 4 && month <= 7) return 1.8;
            return 0.1;
        }
        if (riskType === 'wind') {
            // Winter/Spring
            if (month <= 2 || month >= 10) return 1.5;
            return 0.8;
        }
        return 1.0;
    }

    checkSeismicZone(lat, lng) {
        for (const zone of this.seismicZones) {
            if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLon && lng <= zone.maxLon) {
                return true;
            }
        }
        return false;
    }

    /**
     * Calculates PML based on MSK-64 intensity.
     * @param {Object} targetFeature - GeoJSON Feature (Point or Polygon)
     * @param {Number} totalSum - Insurance amount
     * @param {Object} riskLayers - Object containing risk layers (must have 'earthquake')
     */
    calculatePML_MSK64(targetFeature, totalSum, riskLayers) {
        // Check for Turf.js
        if (typeof turf === 'undefined' && !window.turf) {
            return { pml: 0, maxIntensity: 0, description: 'Turf.js not loaded' };
        }
        const t = (typeof turf !== 'undefined') ? turf : window.turf;

        if (!riskLayers || !riskLayers.earthquake) {
            return { pml: 0, maxIntensity: 0, description: 'Нет данных сейсмозон' };
        }

        let maxIntensity = 0;
        let pmlFactor = 0;

        // 1. Iterate earthquake zones
        t.flatten(riskLayers.earthquake).features.forEach(zone => {
             // Fallback to 9 if intensity is missing but it's a risk zone
             const zoneIntensity = zone.properties.intensity || zone.properties.mag || 9;

             let isIntersect = false;
             try {
                 if (targetFeature.geometry.type === 'Point') {
                     isIntersect = t.booleanPointInPolygon(targetFeature, zone);
                 } else {
                     // For regions/polygons
                     isIntersect = t.intersect(targetFeature, zone);
                 }
             } catch (e) {
                 // ignore topology errors
             }

             if (isIntersect) {
                 if (zoneIntensity > maxIntensity) {
                     maxIntensity = zoneIntensity;
                 }
             }
        });

        // 2. Determine Damage Factor
        if (maxIntensity > 0) {
            pmlFactor = this.MSK_FACTORS[Math.floor(maxIntensity)] || (maxIntensity > 9 ? 1.0 : 0);
        }

        // 3. Calc PML
        const pmlValue = totalSum * pmlFactor;

        return {
            pml: pmlValue,
            factor: pmlFactor,
            maxIntensity: maxIntensity,
            description: maxIntensity > 0
                ? `Расчет по шкале MSK-64: ${maxIntensity} баллов (Коэфф. ${(pmlFactor * 100).toFixed(0)}%)`
                : 'Вне зон сейсмического риска'
        };
    }

    // --- Core Calculation ---

    calculateScore(contract) {
        const { latitude: lat, longitude: lng, startDate } = contract;
        if (!lat || !lng) return { score: 0, level: 'Low', details: {} };

        // Determine Month for Seasonality
        const date = startDate ? new Date(startDate) : new Date();
        const month = date.getMonth();

        // 1. Seismic Risk (Based on Zone)
        const isSeismic = this.checkSeismicZone(lat, lng);
        const seismicScore = isSeismic ? 90 : 10;

        // 2. Flood Risk (Mock: Higher in North >50)
        let floodScore = lat > 50 ? 60 : 20;
        floodScore *= this.getSeasonalityFactor(month, 'flood');

        // 3. Fire Risk (Mock: Higher in South/East)
        let fireScore = (lat < 45 && lng > 75) ? 70 : 30;
        fireScore *= this.getSeasonalityFactor(month, 'fire');

        // 4. Wind Risk (Mock: Higher in West/Caspian or North)
        let windScore = (lng < 55 || lat > 52) ? 65 : 25;
        windScore *= this.getSeasonalityFactor(month, 'wind');

        // 5. Hail Risk (Mock: Seasonality driven)
        let hailScore = 30 * this.getSeasonalityFactor(month, 'hail');

        // 6. Man-Made (Mock: Random or proximity to cities - simplified)
        // Assume cities (Almaty/Astana) have higher man-made risk
        const isCity = (lat > 43 && lat < 43.5 && lng > 76.5 && lng < 77.5) || (lat > 51 && lat < 51.5);
        const manMadeScore = isCity ? 60 : 10;

        // 7. Social Risk (Mock)
        const socialScore = 10; // Low in general

        // Normalize Scores to max 100
        const clamp = (v) => Math.min(100, Math.max(0, v));

        const scores = {
            seismic: clamp(seismicScore),
            flood: clamp(floodScore),
            fire: clamp(fireScore),
            wind: clamp(windScore),
            hail: clamp(hailScore),
            manMade: clamp(manMadeScore),
            social: clamp(socialScore)
        };

        // Weighted Average Score
        let totalScore = 0;
        for (const key in this.WEIGHTS) {
            totalScore += scores[key] * this.WEIGHTS[key];
        }

        // Determine Risk Level
        let level = 'Low';
        if (totalScore >= 75) level = 'Extreme';
        else if (totalScore >= 50) level = 'High';
        else if (totalScore >= 25) level = 'Medium';

        return {
            score: Math.round(totalScore),
            level,
            details: scores
        };
    }

    calculateAggregatePML(contracts) {
        let riskSums = {
            seismic: 0, flood: 0, fire: 0, wind: 0, hail: 0, manMade: 0, social: 0
        };
        let totalPML_1y = 0;
        let totalPML_3y = 0;
        let totalPML_10y = 0;

        contracts.forEach(c => {
            const riskData = c.riskData || this.calculateScore(c);
            const amount = parseFloat(c.insuranceAmount) || 0;
            if (amount === 0) return;

            // Calculate Probability for this contract
            // P = BaseProb * (Score / 100)
            const probs = {};
            for (const key in this.BASE_PROBS) {
                probs[key] = this.BASE_PROBS[key] * (riskData.details[key] / 100);
            }

            // Correlation Multiplier (Simplified)
            // If both Seismic and Fire are high (>50), boost by 20%
            let correlationFactor = 1.0;
            if (riskData.details.seismic > 50 && riskData.details.fire > 50) {
                correlationFactor = 1.2;
            }

            // Calculate Expected Loss (PML Contribution) for 1 Year
            let contractLoss_1y = 0;
            for (const key in this.WEIGHTS) {
                const loss = amount * probs[key] * this.WEIGHTS[key] * correlationFactor;
                contractLoss_1y += loss;
                riskSums[key] += loss;
            }

            // Multi-layer (Time Horizon)
            // P_t = 1 - (1 - P_annual)^t
            // For small P, P_t approx P_annual * t.
            // We apply this scaling to the probability component.

            const calcPeriodLoss = (years) => {
                let periodLoss = 0;
                for (const key in this.WEIGHTS) {
                     // Probability over 'years'
                     const p_annual = probs[key];
                     const p_period = 1 - Math.pow(1 - p_annual, years);
                     periodLoss += amount * p_period * this.WEIGHTS[key] * correlationFactor;
                }
                return periodLoss;
            };

            totalPML_1y += contractLoss_1y;
            totalPML_3y += calcPeriodLoss(3);
            totalPML_10y += calcPeriodLoss(10);
        });

        return {
            total: totalPML_1y,
            periods: {
                short: totalPML_1y,
                medium: totalPML_3y,
                long: totalPML_10y
            },
            breakdown: riskSums,
            formula: `PML = Σ (Amount * P_risk * Weight * Correlation)`
        };
    }

    // Spatial method remains largely the same but could be extended if we had spatial layers for new risks
    calculateRegionalRisks(regionFeature, totalSumKZT, riskLayers) {
        if (typeof turf === 'undefined') {
            console.error("Turf.js is not loaded.");
            return null;
        }

        // NEW MSK-64 CALCULATION
        const mskData = this.calculatePML_MSK64(regionFeature, totalSumKZT, riskLayers);

        const regionArea = turf.area(regionFeature);
        if (regionArea === 0) return null;

        function getExposure(riskGeoJSON) {
            if (!riskGeoJSON || !riskGeoJSON.features) return 0;
            let intersectionArea = 0;
            turf.flatten(riskGeoJSON).features.forEach(riskFeature => {
                try {
                    const intersection = turf.intersect(regionFeature, riskFeature);
                    if (intersection) intersectionArea += turf.area(intersection);
                } catch (e) {}
            });
            let ratio = intersectionArea / regionArea;
            if (ratio > 1) ratio = 1;
            return totalSumKZT * ratio;
        }

        const floodExposure = getExposure(riskLayers.flood);
        const fireExposure = getExposure(riskLayers.fire);

        // Max PML approach: typically take Max(Earthquake, Flood, Fire)
        // because simultaneous catastrophic events are unlikely.
        const totalPML = Math.max(mskData.pml, floodExposure * 0.15, fireExposure * 0.2);

        return {
            earthquake: mskData.pml,
            earthquakeDetails: mskData,
            flood: floodExposure,
            fire: fireExposure,
            pml: totalPML
        };
    }

    calculateScenarios(contracts) {
        // 1. Инициализация накопителей
        const scenarios = {
            'almaty_eq': { name: 'Землетрясение Алматы', exposure: 0, factor: 0.15, count: 0, description: 'Сценарий разрушительного землетрясения в г. Алматы (9 баллов)' },
            'uko_eq': { name: 'Землетрясение ЮКО', exposure: 0, factor: 0.08, count: 0, description: 'Землетрясение в Южно-Казахстанской и Жамбылской областях' },
            'north_flood': { name: 'Паводки Север', exposure: 0, factor: 0.05, count: 0, description: 'Сезонные паводки в речных долинах СКО и Акмолинской области' },
            'fire_east': { name: 'Лесные пожары (Восток/ВКО)', exposure: 0, factor: 0.10, count: 0, description: 'Масштабные лесные пожары в летний период' },
            'general': { name: 'Прочие риски', exposure: 0, factor: 0.01, count: 0, description: 'Остальные риски по портфелю' }
        };

        // 2. Распределение договоров по корзинам
        contracts.forEach(c => {
            const amt = c.insuranceAmount || 0;
            const lat = c.latitude;
            const lng = c.longitude;
            if(!lat || !lng) return;

            let matched = false;

            // Алматы (грубый квадрат или проверка по полигону)
            if (lat >= 43.0 && lat <= 43.5 && lng >= 76.7 && lng <= 77.2) {
                scenarios['almaty_eq'].exposure += amt;
                scenarios['almaty_eq'].count++;
                matched = true;
            }
            // Юг (ЮКО/Жамбыл)
            else if (lat >= 42.0 && lat <= 45.0 && lng >= 69.0 && lng <= 75.0) {
                scenarios['uko_eq'].exposure += amt;
                scenarios['uko_eq'].count++;
                matched = true;
            }
            // Север (Паводки)
            else if (lat > 50.0) {
                scenarios['north_flood'].exposure += amt;
                scenarios['north_flood'].count++;
                matched = true;
            }
            // Восток (Пожары)
            else if (lat > 49 && lng > 80) {
                scenarios['fire_east'].exposure += amt;
                scenarios['fire_east'].count++;
                matched = true;
            }

            if (!matched) {
                scenarios['general'].exposure += amt;
                scenarios['general'].count++;
            }
        });

        // 3. Расчет PML для каждого сценария
        const results = Object.keys(scenarios).map(key => {
            const s = scenarios[key];
            return {
                id: key,
                name: s.name,
                exposure: s.exposure,
                factor: s.factor,
                pml: s.exposure * s.factor,
                count: s.count,
                description: s.description
            };
        });

        // Сортировка по убыванию убытка
        return results.sort((a, b) => b.pml - a.pml);
    }
}
