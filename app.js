
/**
 * Main Application - Heerlen Interactive Map
 * This code handles map initialization, geolocation, markers, popups, and 3D models
 */

// ============= INITIALIZATION & GLOBALS =============
// Configuration
const CONFIG = {
  MAP: {
    center: [5.979642, 50.887634],
    zoom: 15.5,
    pitch: 45,
    bearing: -17.6,
    boundary: {
      center: [5.977105864037915, 50.88774161029858],
      radius: 2.2
    }
  },
  MARKER_ZOOM: {
    min: 10,
    small: 14,
    medium: 16,
    large: 18
  }
};

// Initialize Mapbox
mapboxgl.accessToken = "pk.eyJ1IjoicHJvamVjdGhlZXJsZW4iLCJhIjoiY2x4eWVmcXBvMWozZTJpc2FqbWgzcnAyeCJ9.SVOVbBG6o1lHs6TwCudR9g";

// Global state
let activePopup = null;
let markersAdded = false;
let modelsAdded = false;
const mapLocations = { 
  type: "FeatureCollection", 
  features: [] 
};

// Initialize map
const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/projectheerlen/clxyeqfbu000r01qpd37l0fhu",
  center: CONFIG.MAP.center,
  zoom: CONFIG.MAP.zoom,
  pitch: CONFIG.MAP.pitch,
  bearing: CONFIG.MAP.bearing,
  antialias: true,
  interactive: true
});

/**
 * Enhanced GeolocationManager
 * Manages user location tracking, search radius, navigation, and boundary checking
 * with improved feedback and performance optimizations
 */
class GeolocationManager {
  constructor(map) {
    this.map = map;
    
    // Configuration
    this.config = {
      radius: {
        searchId: "search-radius",
        outerSearchId: "search-radius-outer",
        inMeters: 50,
        maxInMeters: 100,
      },
      boundary: {
        layerIds: ["boundary-fill", "boundary-line", "boundary-label"],
        centerPoint: CONFIG.MAP.boundary.center,
        radius: CONFIG.MAP.boundary.radius,
      },
      performance: {
        updateThreshold: 500, // ms between updates
        markerScaleFactor: 1.5, // How much to scale markers in proximity
      },
      dragDetection: {
        threshold: 50, // px - distance needed to consider a drag
        timeLimit: 500, // ms - time limit for drag detection
      }
    };
    
    // State
    this.state = {
      distanceMarkers: [],
      proximityMarkers: [],
      isPopupOpen: false,
      isNavigationMode: false,
      isTracking: false,
      isFirstLocation: true,
      wasOutsideBoundary: false,
      locationStatus: 'inactive', // inactive, finding, active, tracking, error
      lastUpdateTime: 0,
      activeNotifications: {},
      proximityAnimationFrame: null,
      trackingNotificationShown: false,
      activeNotificationShown: false,
      dragDetection: {
        isDragging: false,
        startX: 0,
        startY: 0,
        startTime: 0,
      }
    };
    
    // Initialize components
    this.ui = new UIManager(this);
    this.visualization = new VisualizationManager(this);
    
    this.initialize();
  }

  /**
   * Initialize geolocation features
   */
  initialize() {
    this.setupGeolocateControl();
    this.visualization.setupSearchRadius();
    this.visualization.setupBoundaryCheck();
    this.ui.setupNavigationToggle();
    
    // Add event listeners for view changes
    this.map.on('zoom', () => this.updateProximityMarkers());
    this.map.on('move', this.throttle(() => this.updateProximityMarkers(), 100));
  }

  /**
   * Setup geolocate control with event handlers
   */
  setupGeolocateControl() {
    // Remove any existing controls
    document.querySelectorAll(".mapboxgl-ctrl-top-right .mapboxgl-ctrl-group")
      .forEach(el => el.remove());
    document.querySelectorAll(".mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-group")
      .forEach(el => el.remove());

    // Create geolocate control with improved options
    this.geolocateControl = new mapboxgl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 6000
      },
      trackUserLocation: true,
      showUserHeading: true,
      showAccuracyCircle: false,
      fitBoundsOptions: { 
        maxZoom: 17.5, 
        animate: true 
      }
    });

    // Setup event listeners
    this.setupGeolocateEvents();

    // Add control to map
    this.map.addControl(this.geolocateControl, "bottom-right");
    this.map.addControl(new mapboxgl.NavigationControl(), "top-right");
  }
  
  /**
   * Setup geolocate events and handlers
   */
  setupGeolocateEvents() {
    // Single location update (first click)
    this.geolocateControl.on("geolocate", position => {
      console.log("Geolocate event triggered");
      this.state.locationStatus = 'active';
      this.ui.updateGeoStatusIndicator();
      
      // Always show the boundary layers
      this.visualization.showBoundaryLayers();
      
      // Show notification only once
      if (!this.state.activeNotificationShown) {
        this.ui.showNotification('Locatie actief');
        this.state.activeNotificationShown = true;
      }
      
      this.handleLocationChange(position, false);
    });

    // Continuous tracking updates
    this.geolocateControl.on("trackuserlocationupdate", position => {
      // Only follow the user if actually tracking
      if (this.state.isTracking) {
        if (this.state.isNavigationMode) {
          const heading = position.coords.heading || 0;
          this.map.easeTo({ bearing: heading, duration: 0 });
        }
        this.handleLocationChange(position, true);
      }
    });

    // Handle geolocation errors
    this.geolocateControl.on("error", error => this.handleGeolocationError(error));

    // Make sure search radius remains visible in active mode
    this.geolocateControl.on('update', (position) => {
      if (this.state.locationStatus === 'active' && !this.state.isTracking) {
        const userPosition = [position.coords.longitude, position.coords.latitude];
        if (this.isWithinBoundary(userPosition)) {
          this.visualization.updateSearchRadius(userPosition);
        }
      }
    });

    // Tracking started
    this.geolocateControl.on("trackuserlocationstart", () => {
      console.log("Location tracking started");
      this.state.isTracking = true;
      this.state.locationStatus = 'tracking';
      this.ui.updateGeoStatusIndicator();
      this.visualization.showBoundaryLayers();
      
      // Show notification only if not already shown
      if (!this.state.trackingNotificationShown) {
        const notificationText = this.state.isNavigationMode ? 
          'Locatie tracking en navigatie actief' : 
          'Locatie tracking actief';
        this.ui.showNotification(notificationText);
        this.state.trackingNotificationShown = true;
      }
      
      this.checkLocationPermissions();
      this.setupMapDragDetection();
    });

    // Tracking ended
    this.geolocateControl.on("trackuserlocationend", () => {
      console.log("Location tracking ended");
      this.resetLocationState();
      this.ui.showNotification('Locatie tracking gestopt');
    });

    // Style geolocate button and set up click handler
    this.map.once("idle", () => {
      const geolocateButton = document.querySelector(".mapboxgl-ctrl-geolocate");
      if (geolocateButton && geolocateButton.parentElement) {
        // Optimize position
        geolocateButton.parentElement.style.position = "absolute";
        geolocateButton.parentElement.style.bottom = "clamp(20px, 10vh, 40px)";
        geolocateButton.parentElement.style.right = "10px";
        
        // Add status indicator
        this.geoStatusIndicator = this.ui.createStatusIndicator(geolocateButton.parentElement);
        
        // Add click handler
        geolocateButton.addEventListener('click', () => {
          this.ui.pulseElement(geolocateButton);
          this.visualization.showBoundaryLayers();
          
          // Toggle between active and tracking states
          if (this.state.locationStatus === 'inactive' || this.state.locationStatus === 'error') {
            // First click - activate location without tracking
            console.log("First click - activating location");
            this.state.activeNotificationShown = false; // Reset to show notification again
            this.geolocateControl._onClickGeolocate(); // Get location once
          } else if (this.state.locationStatus === 'active') {
            // Second click - start tracking
            console.log("Second click - start tracking");
            this.state.isTracking = true;
            this.state.locationStatus = 'tracking';
            this.state.trackingNotificationShown = false; // Reset to show notification again
            this.ui.updateGeoStatusIndicator();
            this.ui.showNotification('Locatie tracking actief');
            this.geolocateControl._setup = true;
            this.geolocateControl._updateMarker = true;
            this.geolocateControl.trackLocation = true;
            this.setupMapDragDetection();
          }
        });
      }
    });
  }
  
  /**
   * Handle all location changes from either single location or tracking
   */
  handleLocationChange(position, isTracking) {
    const userPosition = [position.coords.longitude, position.coords.latitude];
    const heading = position.coords.heading || 0;
    
    if (this.isWithinBoundary(userPosition)) {
      // Always update the search radius visualization
      this.visualization.updateSearchRadius(userPosition);
      
      // Update markers for nearby locations
      this.updateDistanceMarkers(userPosition);
      
      // Welcome message if coming from outside the boundary
      if (this.state.wasOutsideBoundary) {
        this.ui.showNotification('Welkom in Heerlen! Je bent nu in het interactieve gebied.');
        this.state.wasOutsideBoundary = false;
      }
      
      // First location handling - fly to user once
      if (this.state.isFirstLocation) {
        this.flyToUser(userPosition, isTracking && this.state.isNavigationMode ? heading : 0);
        this.state.isFirstLocation = false;
        
        // Show welcome instruction after a delay
        setTimeout(() => {
          this.ui.showWelcomeInstruction();
        }, 2500);
      } 
      // Regular location update in tracking mode
      else if (!this.state.isPopupOpen && isTracking) {
        this.updateMapPosition(userPosition, heading);
      }
    } else {
      this.handleUserOutsideBoundary(userPosition);
    }
  }
  
  /**
   * Fly to user with appropriate animation
   */
  flyToUser(userPosition, heading) {
    this.map.flyTo({
      center: userPosition,
      zoom: 17.5,
      pitch: 45,
      duration: 2000,
      bearing: heading,
      essential: true
    });
  }
  
  /**
   * Update map position for tracking mode
   */
  updateMapPosition(userPosition, heading) {
    // Determine if we should update the map position
    const mapCenter = this.map.getCenter();
    const distanceChange = this.calculateDistance(
      mapCenter.lat, mapCenter.lng, 
      userPosition[1], userPosition[0]
    );
    
    // If in navigation mode, always follow with heading
    if (this.state.isNavigationMode) {
      this.map.easeTo({ 
        center: userPosition, 
        bearing: heading,
        duration: 500 
      });
    }
    // Otherwise only update if moved significantly and in tracking mode
    else if (this.state.isTracking && distanceChange > 0.03) { // ~30m threshold
      this.map.easeTo({ 
        center: userPosition, 
        duration: 1000 
      });
    }
  }
  
  /**
   * Handle when user is outside boundary
   */
  handleUserOutsideBoundary(userPosition) {
    if (!this.state.wasOutsideBoundary) {
      this.state.wasOutsideBoundary = true;
      this.ui.showBoundaryPopup(userPosition);
    }
  }

  /**
   * Reset location tracking state
   */
  resetLocationState() {
    this.state.isTracking = false;
    this.state.isFirstLocation = true;
    this.state.locationStatus = 'inactive';
    this.state.trackingNotificationShown = false;
    this.state.activeNotificationShown = false;
    this.ui.updateGeoStatusIndicator();
    
    // Reset map orientation
    this.map.easeTo({ bearing: 0, pitch: 45 });
    
    // Clear visualizations
    this.visualization.clearSearchRadius();
    this.visualization.hideBoundaryLayers();
    
    // Reset navigation mode if active
    if (this.state.isNavigationMode) {
      this.toggleNavigationMode();
    }
    
    // Clear distance markers
    this.clearDistanceMarkers();
    
    // Reset marker scaling
    this.resetMarkerScaling();
    
    // Cancel any animations
    if (this.state.proximityAnimationFrame) {
      cancelAnimationFrame(this.state.proximityAnimationFrame);
    }
    
    // Remove map drag detection
    this.cleanupMapDragDetection();
  }

  /**
   * Check for location permissions and show guidance if needed
   */
  checkLocationPermissions() {
    navigator.permissions.query({name:'geolocation'}).then(result => {
      if (result.state === 'prompt') {
        this.ui.showNotification('Sta locatietoegang toe om de interactieve kaart te gebruiken', 'info', 5000);
      }
    });
  }

  /**
   * Toggle between normal and navigation mode
   */
  toggleNavigationMode() {
    this.state.isNavigationMode = !this.state.isNavigationMode;
    
    if (this.state.isNavigationMode) {
      // Start navigation mode
      this.ui.updateNavButton(true);
      
      // Start tracking if not already tracking
      const wasNotTracking = !this.state.isTracking;
      if (wasNotTracking) {
        // Don't show notification here, it will be shown by trackuserlocationstart event
        this.geolocateControl.trigger();
      } else {
        // Only show notification if we're already tracking
        this.ui.showNotification('Navigatie gestart. De kaart draait nu mee met je beweging.');
        this.ui.updateGeoStatusIndicator(); // Update indicator to show navigation is active
      }
      
      // Show compass
      this.ui.showNavigationCompass();
    } else {
      // Stop navigation mode
      this.ui.updateNavButton(false);
      
      // Reset map bearing
      this.map.easeTo({ bearing: 0, pitch: 45, duration: 1000 });
      
      // Hide compass
      this.ui.hideNavigationCompass();
      
      // Show feedback notification
      this.ui.showNotification('Navigatie gestopt. Locatie tracking blijft actief.');
      this.ui.updateGeoStatusIndicator(); // Update indicator to show only tracking
    }
  }

  /**
   * Create and update distance markers based on user location
   * Also scales markers based on proximity
   */
  updateDistanceMarkers(userPosition) {
    // Skip if update is too frequent
    const now = Date.now();
    if (now - this.state.lastUpdateTime < this.config.performance.updateThreshold) return;
    this.state.lastUpdateTime = now;
    
    // Clear existing markers
    this.clearDistanceMarkers();
    
    // Reset proximity scaling on map markers
    this.resetMarkerScaling();

    // Track markers in proximity for visual enhancement
    const markersInProximity = [];
    
    // Add new markers for features within radius
    mapLocations.features.forEach(feature => {
      const featureCoords = feature.geometry.coordinates;
      const distance = 1000 * this.calculateDistance(
        userPosition[1], userPosition[0], 
        featureCoords[1], featureCoords[0]
      );

      if (distance <= this.config.radius.inMeters) {
        // Create and add distance marker
        const marker = this.createDistanceMarker(feature, featureCoords, distance);
        this.state.distanceMarkers.push(marker);
        
        // Track for proximity enhancement
        markersInProximity.push({
          id: feature.properties.id,
          distance: distance,
          coords: featureCoords
        });
      }
    });
    
    // Enhance map markers based on proximity
    this.enhanceMarkersInProximity(markersInProximity);
  }
  
  /**
   * Create a single distance marker element
   */
  createDistanceMarker(feature, featureCoords, distance) {
    const markerEl = document.createElement("div");
    markerEl.className = "distance-marker";
    
    // Add proximity indicator
    const proximityClass = distance <= this.config.radius.inMeters / 2 ? "very-close" : "close";
    markerEl.classList.add(proximityClass);
    
    // Add distance text
    markerEl.innerHTML = `
      <span class="distance-marker-distance">${Math.round(distance)}m</span>
      <span class="distance-marker-name">${feature.properties.name}</span>
    `;

    const marker = new mapboxgl.Marker({ element: markerEl })
      .setLngLat(featureCoords)
      .addTo(this.map);

    // Add click handler
    markerEl.addEventListener("click", () => {
      this.map.fire("click", {
        lngLat: { lng: featureCoords[0], lat: featureCoords[1] },
        point: this.map.project(featureCoords),
        features: [feature]
      });
    });
    
    return marker;
  }
  
  /**
   * Clear existing distance markers
   */
  clearDistanceMarkers() {
    if (this.state.distanceMarkers.length) {
      this.state.distanceMarkers.forEach(marker => marker.remove());
      this.state.distanceMarkers = [];
    }
  }
  
  /**
   * Reset scaling on all map markers
   */
  resetMarkerScaling() {
    if (!this.map.getLayer('location-icons')) return;
    
    // Reset icon size interpolation to default
    this.map.setPaintProperty('location-icons', 'icon-opacity', 1);
    this.map.setLayoutProperty('location-icons', 'icon-size', [
      "interpolate",
      ["linear"],
      ["zoom"],
      CONFIG.MARKER_ZOOM.min, 0.05,
      CONFIG.MARKER_ZOOM.small, 0.08,
      CONFIG.MARKER_ZOOM.medium, 0.12,
      CONFIG.MARKER_ZOOM.large, 0.15
    ]);
    
    // Reset circle radius to default
    this.map.setPaintProperty('location-markers', 'circle-radius', [
      "interpolate",
      ["linear"],
      ["zoom"],
      CONFIG.MARKER_ZOOM.min, 2,
      CONFIG.MARKER_ZOOM.small, 5,
      CONFIG.MARKER_ZOOM.medium, 8,
      CONFIG.MARKER_ZOOM.large, 10
    ]);
    
    // Reset opacity
    this.map.setPaintProperty('location-labels', 'text-opacity', 1);
  }
  
  /**
   * Enhance markers that are in proximity to the user
   */
  enhanceMarkersInProximity(markersInProximity) {
    if (!this.map.getLayer('location-icons') || markersInProximity.length === 0) return;
    
    try {
      const iconSizeExp = this.createProximityExpression(markersInProximity, 'icon');
      const circleRadiusExp = this.createProximityExpression(markersInProximity, 'circle');
      
      // Apply enhanced sizing
      this.map.setLayoutProperty('location-icons', 'icon-size', iconSizeExp);
      this.map.setPaintProperty('location-markers', 'circle-radius', circleRadiusExp);
      
      // Add pulsing effect to nearby markers
      this.animateProximityMarkers(markersInProximity);
    } catch (error) {
      console.error('Error enhancing markers:', error);
    }
  }
  
  /**
   * Create expression for marker scaling based on proximity
   */
  createProximityExpression(markersInProximity, type) {
    const exp = ['case'];
    const defaultSizes = type === 'icon' 
      ? [0.05, 0.08, 0.12, 0.15]
      : [2, 5, 8, 10];
    
    // Add match for each marker in proximity
    markersInProximity.forEach(marker => {
      // Scale factor based on distance (closer = larger)
      const scaleFactor = this.config.performance.markerScaleFactor * 
                          (1 - marker.distance / this.config.radius.inMeters);
      
      // Match for this marker based on ID
      exp.push(['==', ['get', 'id'], marker.id]);
      
      // Scale size based on zoom with enhancement
      exp.push([
        "interpolate",
        ["linear"],
        ["zoom"],
        CONFIG.MARKER_ZOOM.min, defaultSizes[0] * (1 + scaleFactor),
        CONFIG.MARKER_ZOOM.small, defaultSizes[1] * (1 + scaleFactor),
        CONFIG.MARKER_ZOOM.medium, defaultSizes[2] * (1 + scaleFactor),
        CONFIG.MARKER_ZOOM.large, defaultSizes[3] * (1 + scaleFactor)
      ]);
    });
    
    // Default case - normal sizing
    exp.push([
      "interpolate",
      ["linear"],
      ["zoom"],
      CONFIG.MARKER_ZOOM.min, defaultSizes[0],
      CONFIG.MARKER_ZOOM.small, defaultSizes[1],
      CONFIG.MARKER_ZOOM.medium, defaultSizes[2],
      CONFIG.MARKER_ZOOM.large, defaultSizes[3]
    ]);
    
    return exp;
  }
  
  /**
   * Add subtle animation to markers in proximity
   */
  animateProximityMarkers(markersInProximity) {
    // Clear any existing animation
    if (this.state.proximityAnimationFrame) {
      cancelAnimationFrame(this.state.proximityAnimationFrame);
    }
    
    if (!this.map.getLayer('location-markers') || markersInProximity.length === 0) return;
    
    try {
      const startTime = Date.now();
      const pulseFactor = 0.3; // How much to pulse
      
      const animate = () => {
        const elapsed = Date.now() - startTime;
        
        // Calculate pulse - oscillates between 1 and 1+pulseFactor
        const pulse = 1 + (Math.sin(elapsed / 500) + 1) / 2 * pulseFactor;
        
        // Create expression for marker size animation
        const animExp = this.createPulseExpression(markersInProximity, pulse);
        
        // Apply animation
        this.map.setPaintProperty('location-markers', 'circle-radius', animExp);
        
        // Continue animation
        this.state.proximityAnimationFrame = requestAnimationFrame(animate);
      };
      
      // Start animation
      this.state.proximityAnimationFrame = requestAnimationFrame(animate);
    } catch (error) {
      console.error('Error animating markers:', error);
    }
  }
  
  /**
   * Create expression for marker pulse animation
   */
  createPulseExpression(markersInProximity, pulse) {
    const animExp = ['case'];
    
    // Add case for each marker in proximity
    markersInProximity.forEach(marker => {
      // Base scale factor on distance
      const distanceScale = 1 - (marker.distance / this.config.radius.inMeters);
      
      // Apply pulse stronger to closer markers
      const markerPulse = 1 + (pulse - 1) * distanceScale;
      
      // Add match for this marker
      animExp.push(['==', ['get', 'id'], marker.id]);
      animExp.push([
        "interpolate",
        ["linear"],
        ["zoom"],
        CONFIG.MARKER_ZOOM.min, 2 * markerPulse,
        CONFIG.MARKER_ZOOM.small, 5 * markerPulse,
        CONFIG.MARKER_ZOOM.medium, 8 * markerPulse,
        CONFIG.MARKER_ZOOM.large, 10 * markerPulse
      ]);
    });
    
    // Default case - normal sizing
    animExp.push([
      "interpolate",
      ["linear"],
      ["zoom"],
      CONFIG.MARKER_ZOOM.min, 2,
      CONFIG.MARKER_ZOOM.small, 5,
      CONFIG.MARKER_ZOOM.medium, 8,
      CONFIG.MARKER_ZOOM.large, 10
    ]);
    
    return animExp;
  }
  
  /**
   * Update proximity markers when map moves or zooms
   */
  updateProximityMarkers() {
    if (!this.state.isTracking && this.state.locationStatus !== 'active') return;
    
    // Get current user position from geolocate control
    const userLocation = this.geolocateControl._lastKnownPosition;
    if (!userLocation) return;
    
    const userPosition = [userLocation.coords.longitude, userLocation.coords.latitude];
    this.updateDistanceMarkers(userPosition);
  }

  /**
   * Handle geolocation errors with more descriptive messages
   */
  handleGeolocationError(error) {
    console.error("Geolocation error:", error);
    
    this.state.locationStatus = 'error';
    this.ui.updateGeoStatusIndicator();
    
    const errorMessages = {
      1: "Locatie toegang geweigerd. Geef toegang in je browser instellingen om de interactieve kaart te gebruiken.",
      2: "Je locatie kan niet worden bepaald. Controleer je GPS of netwerk verbinding.",
      3: "Verzoek verlopen. Controleer je verbinding en probeer opnieuw.",
      default: "Er is een fout opgetreden bij het ophalen van je locatie. Probeer het later opnieuw."
    };
    
    this.ui.showNotification(errorMessages[error.code] || errorMessages.default, 'error', 7000);
    
    // Show help instructions for permission errors
    if (error.code === 1) {
      setTimeout(() => {
        this.ui.showLocationPermissionHelp();
      }, 1000);
    }
  }

  /**
   * Create boundary circle GeoJSON with improved precision
   */
  createBoundaryCircle() {
    const center = { 
      latitude: this.config.boundary.centerPoint[1], 
      longitude: this.config.boundary.centerPoint[0] 
    };
    
    const radiusKm = this.config.boundary.radius;
    const points = [];

    // Convert km to degrees based on latitude
    const degreesLongPerKm = radiusKm / (111.32 * Math.cos(center.latitude * Math.PI / 180));
    const degreesLatPerKm = radiusKm / 110.574;

    // Generate points around the circle
    for (let i = 0; i <= 72; i++) {
      const angle = (i / 72) * (2 * Math.PI);
      const dx = degreesLongPerKm * Math.cos(angle);
      const dy = degreesLatPerKm * Math.sin(angle);
      points.push([center.longitude + dx, center.latitude + dy]);
    }

    return {
      type: "Feature",
      properties: {
        center: this.config.boundary.centerPoint,
        radius: this.config.boundary.radius
      },
      geometry: { 
        type: "Polygon", 
        coordinates: [points] 
      }
    };
  }

  /**
   * Check if position is within boundary
   */
  isWithinBoundary(position) {
    return this.calculateDistance(
      position[1], position[0],
      this.config.boundary.centerPoint[1], this.config.boundary.centerPoint[0]
    ) <= this.config.boundary.radius;
  }

  /**
   * Calculate distance between coordinates in km
   * Optimized Haversine formula implementation
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    // Earth radius in km
    const R = 6371;
    
    // Convert degrees to radians
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const radLat1 = this.toRad(lat1);
    const radLat2 = this.toRad(lat2);
    
    // Calculate haversine formula
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(radLat1) * Math.cos(radLat2) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
      
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  /**
   * Convert degrees to radians
   */
  toRad(deg) {
    return deg * (Math.PI / 180);
  }
  
  /**
   * Get angle from user position to center
   */
  getDirectionToCenterAngle(userPosition) {
    const dx = this.config.boundary.centerPoint[0] - userPosition[0];
    const dy = this.config.boundary.centerPoint[1] - userPosition[1];
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    
    // Convert to 0-360 range
    if (angle < 0) {
      angle += 360;
    }
    
    return angle;
  }
  
  /**
   * Get text description of direction to center
   */
  getDirectionToCenterText(userPosition) {
    const angle = this.getDirectionToCenterAngle(userPosition);
    
    // Convert angle to cardinal direction
    if (angle >= 337.5 || angle < 22.5) {
      return "het oosten";
    } else if (angle >= 22.5 && angle < 67.5) {
      return "het zuidoosten";
    } else if (angle >= 67.5 && angle < 112.5) {
      return "het zuiden";
    } else if (angle >= 112.5 && angle < 157.5) {
      return "het zuidwesten";
    } else if (angle >= 157.5 && angle < 202.5) {
      return "het westen";
    } else if (angle >= 202.5 && angle < 247.5) {
      return "het noordwesten";
    } else if (angle >= 247.5 && angle < 292.5) {
      return "het noorden";
    } else { // >= 292.5 && < 337.5
      return "het noordoosten";
    }
  }
  
  /**
   * Get distance to center in km
   */
  getDistanceToCenter(userPosition) {
    return this.calculateDistance(
      userPosition[1], userPosition[0],
      this.config.boundary.centerPoint[1], this.config.boundary.centerPoint[0]
    );
  }
  
  /**
   * Setup map drag detection to stop tracking on significant map movements
   */
  setupMapDragDetection() {
    // Clean up any existing handlers first
    this.cleanupMapDragDetection();
    
    // Track drag start
    this.dragStartHandler = (e) => {
      this.state.dragDetection.isDragging = true;
      this.state.dragDetection.startX = e.originalEvent.clientX || e.originalEvent.touches[0].clientX;
      this.state.dragDetection.startY = e.originalEvent.clientY || e.originalEvent.touches[0].clientY;
      this.state.dragDetection.startTime = Date.now();
    };
    
    // Track drag end
    this.dragEndHandler = (e) => {
      if (!this.state.dragDetection.isDragging) return;
      
      const endX = e.originalEvent.clientX || e.originalEvent.changedTouches[0].clientX;
      const endY = e.originalEvent.clientY || e.originalEvent.changedTouches[0].clientY;
      const endTime = Date.now();
      
      // Calculate distance and time
      const deltaX = Math.abs(endX - this.state.dragDetection.startX);
      const deltaY = Math.abs(endY - this.state.dragDetection.startY);
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const timeDiff = endTime - this.state.dragDetection.startTime;
      
      // If significant drag, stop tracking
      if (distance > this.config.dragDetection.threshold && 
          timeDiff < this.config.dragDetection.timeLimit &&
          this.state.isTracking) {
        console.log("Significant map drag detected, stopping tracking");
        this.geolocateControl._onTrackUserLocationEnd();
      }
      
      this.state.dragDetection.isDragging = false;
    };
    
    // Add event listeners
    this.map.on('mousedown', this.dragStartHandler);
    this.map.on('touchstart', this.dragStartHandler);
    this.map.on('mouseup', this.dragEndHandler);
    this.map.on('touchend', this.dragEndHandler);
  }
  
  /**
   * Clean up map drag detection handlers
   */
  cleanupMapDragDetection() {
    if (this.dragStartHandler) {
      this.map.off('mousedown', this.dragStartHandler);
      this.map.off('touchstart', this.dragStartHandler);
      this.map.off('mouseup', this.dragEndHandler);
      this.map.off('touchend', this.dragEndHandler);
      
      this.dragStartHandler = null;
      this.dragEndHandler = null;
    }
  }
  
  /**
   * Throttle function to limit frequency of function calls
   */
  throttle(func, limit) {
    let lastCall = 0;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        return func.apply(this, args);
      }
    };
  }
}

/**
 * UI Manager - Handles all UI-related functionality
 */
class UIManager {
  constructor(geoManager) {
    this.geoManager = geoManager;
    this.map = geoManager.map;
    this.state = geoManager.state;
    this.config = geoManager.config;
  }
  
  /**
   * Setup navigation toggle button
   */
  setupNavigationToggle() {
    // Create container
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'navigation-toggle-container mapboxgl-ctrl';
    
    // Create toggle button
    this.navToggleBtn = document.createElement('button');
    this.navToggleBtn.className = 'navigation-toggle-button';
    this.navToggleBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';
    this.navToggleBtn.title = 'Start navigatie';
    
    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'navigation-tooltip';
    tooltip.textContent = 'Start navigatie';
    
    // Add to container and DOM
    toggleContainer.appendChild(this.navToggleBtn);
    toggleContainer.appendChild(tooltip);
    
    // Wait for map to be ready
    this.map.once('idle', () => {
      document.body.appendChild(toggleContainer);
      
      // Position near geolocate control
      const geolocateBtn = document.querySelector('.mapboxgl-ctrl-geolocate');
      if (geolocateBtn) {
        const geoRect = geolocateBtn.getBoundingClientRect();
        toggleContainer.style.position = 'absolute';
        toggleContainer.style.bottom = `${window.innerHeight - geoRect.top + 10}px`;
        toggleContainer.style.right = '10px';
      }
      
      // Add click handler
      this.navToggleBtn.addEventListener('click', () => this.geoManager.toggleNavigationMode());
    });
  }
  
  /**
   * Update navigation button state
   */
  updateNavButton(isActive) {
    if (isActive) {
      this.navToggleBtn.classList.add('active');
      this.navToggleBtn.title = 'Stop navigatie';
      document.querySelector('.navigation-tooltip').textContent = 'Stop navigatie';
    } else {
      this.navToggleBtn.classList.remove('active');
      this.navToggleBtn.title = 'Start navigatie';
      document.querySelector('.navigation-tooltip').textContent = 'Start navigatie';
    }
  }
  
  /**
   * Create status indicator for geolocation
   */
  createStatusIndicator(parent) {
    const statusIndicator = document.createElement('div');
    statusIndicator.className = 'geolocate-status';
    statusIndicator.innerHTML = '<span>Locatie</span>';
    statusIndicator.style.fontSize = '10px';
    statusIndicator.style.textAlign = 'center';
    statusIndicator.style.marginTop = '2px';
    statusIndicator.style.color = '#666';
    parent.appendChild(statusIndicator);
    return statusIndicator;
  }
  
  /**
   * Update status indicator text based on current state
   */
  updateGeoStatusIndicator() {
    if (!this.geoManager.geoStatusIndicator) return;
    
    let statusText = 'Locatie';
    let statusColor = '#666';
    
    switch(this.state.locationStatus) {
      case 'finding':
        statusText = 'Zoeken...';
        statusColor = '#4B83F2';
        break;
      case 'active':
        statusText = 'Actief';
        statusColor = '#4B83F2';
        break;
      case 'tracking':
        statusText = this.state.isNavigationMode ? 'Volgen + Navigatie' : 'Volgen';
        statusColor = '#4B83F2';
        break;
      case 'error':
        statusText = 'Fout';
        statusColor = '#E63946';
        break;
    }
    
    this.geoManager.geoStatusIndicator.innerHTML = `<span>${statusText}</span>`;
    this.geoManager.geoStatusIndicator.style.color = statusColor;
    this.geoManager.geoStatusIndicator.style.fontWeight = 
      (this.state.locationStatus === 'tracking' || this.state.locationStatus === 'active') ? 'bold' : 'normal';
  }
  
  /**
   * Show navigation compass for orientation
   */
  showNavigationCompass() {
    // Remove existing compass if any
    this.hideNavigationCompass();
    
    // Create compass
    const compass = document.createElement('div');
    compass.id = 'navigation-compass';
    compass.innerHTML = `
      <div class="compass-circle">
        <div class="compass-north">N</div>
        <div class="compass-east">O</div>
        <div class="compass-south">Z</div>
        <div class="compass-west">W</div>
        <div class="compass-needle"></div>
      </div>
    `;
    
    document.body.appendChild(compass);
    
    // Update needle on bearing change
    this.map.on('rotate', this.updateCompassNeedle);
    this.updateCompassNeedle();
  }

  /**
   * Update compass needle to reflect current map bearing
   */
  updateCompassNeedle = () => {
    const needle = document.querySelector('.compass-needle');
    if (needle) {
      const bearing = this.map.getBearing();
      needle.style.transform = `rotate(${bearing}deg)`;
    }
  }

  /**
   * Hide navigation compass
   */
  hideNavigationCompass() {
    const compass = document.getElementById('navigation-compass');
    
    if (compass) {
      compass.remove();
    }
    
    this.map.off('rotate', this.updateCompassNeedle);
  }
  
  /**
   * Show welcome instruction for first-time usage
   */
  showWelcomeInstruction() {
    // Create instruction panel
    const instruction = document.createElement('div');
    instruction.className = 'welcome-instruction';
    instruction.innerHTML = `
      <div class="instruction-content">
        <h3>Welkom bij Heerlen Interactief</h3>
        <div class="instruction-icons">
          <div class="instruction-icon-item">
            <div class="icon-container">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
            </div>
            <div class="icon-text">
              <strong>Locatie Actief</strong><br>
              <span>Toont je positie op de kaart<br>
              <small>Tik 1× op de locatieknop</small></span>
            </div>
          </div>
          <div class="instruction-icon-item">
            <div class="icon-container">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            </div>
            <div class="icon-text">
              <strong>Locatie Volgen</strong><br>
              <span>Volgt je tijdens het verkennen<br>
              <small>Tik 2× op de locatieknop</small></span>
            </div>
          </div>
        </div>
        <button class="instruction-close-btn">Begrepen</button>
      </div>
    `;
    
    document.body.appendChild(instruction);
    
    // Handle close button
    instruction.querySelector('.instruction-close-btn').addEventListener('click', () => {
      instruction.style.animation = 'slide-down 0.5s ease-out forwards';
      
      // Create keyframes for slide-down
      const keyframes = document.createElement('style');
      keyframes.textContent = `
        @keyframes slide-down {
          from { transform: translateX(-50%) translateY(0); opacity: 1; }
          to { transform: translateX(-50%) translateY(100%); opacity: 0; }
        }
      `;
      document.head.appendChild(keyframes);
      
      setTimeout(() => {
        instruction.remove();
        keyframes.remove();
      }, 500);
    });
  }
  
  /**
   * Show help instructions for enabling location permissions
   */
  showLocationPermissionHelp() {
    const helpDialog = document.createElement('div');
    helpDialog.className = 'location-help-dialog';
    
    // Detect browser for specific instructions
    const browser = this.detectBrowser();
    
    helpDialog.innerHTML = `
      <div class="help-dialog-content">
        <h3>Locatietoegang inschakelen</h3>
        <p>Om de interactieve kaart te gebruiken, moet je locatietoegang inschakelen.</p>
        
        <div class="browser-instructions">
          <h4>Instructies voor ${browser.name}</h4>
          <ol>
            ${this.getPermissionInstructions(browser)}
          </ol>
        </div>
        
        <div class="dialog-buttons">
          <button class="try-again-btn">Probeer opnieuw</button>
          <button class="close-help-btn">Sluiten</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(helpDialog);
    
    // Handle buttons
    helpDialog.querySelector('.try-again-btn').addEventListener('click', () => {
      helpDialog.remove();
      
      // Trigger geolocation again
      setTimeout(() => {
        this.geoManager.geolocateControl.trigger();
      }, 500);
    });
    
    helpDialog.querySelector('.close-help-btn').addEventListener('click', () => {
      helpDialog.remove();
    });
  }
  
  /**
   * Detect user's browser for location instructions
   */
  detectBrowser() {
    const userAgent = navigator.userAgent;
    let browserName = "je browser";
    let type = "desktop";
    
    // Check for mobile
    if (/android/i.test(userAgent)) {
      type = "android";
      if (/chrome/i.test(userAgent)) {
        browserName = "Chrome (Android)";
      } else if (/firefox/i.test(userAgent)) {
        browserName = "Firefox (Android)";
      } else {
        browserName = "Android Browser";
      }
    } else if (/iPad|iPhone|iPod/.test(userAgent)) {
      type = "ios";
      if (/CriOS/i.test(userAgent)) {
        browserName = "Chrome (iOS)";
      } else if (/FxiOS/i.test(userAgent)) {
        browserName = "Firefox (iOS)";
      } else {
        browserName = "Safari (iOS)";
      }
    } else {
      // Desktop browsers
      if (/firefox/i.test(userAgent)) {
        browserName = "Firefox";
      } else if (/chrome/i.test(userAgent)) {
        browserName = "Chrome";
      } else if (/safari/i.test(userAgent)) {
        browserName = "Safari";
      } else if (/edge/i.test(userAgent)) {
        browserName = "Edge";
      }
    }
    
    return { name: browserName, type: type };
  }
  
  /**
   * Get browser-specific permission instructions
   */
  getPermissionInstructions(browser) {
    switch(browser.type) {
      case "android":
        return `
          <li>Tik op het slotje of 'i' icoon in de adresbalk.</li>
          <li>Tik op 'Sitevoorkeuren' of 'Site-instellingen'.</li>
          <li>Zet 'Locatie' aan.</li>
          <li>Herlaad de pagina.</li>
        `;
      case "ios":
        return `
          <li>Ga naar je telefoon Instellingen.</li>
          <li>Scroll naar beneden en tik op Safari (of de browser die je gebruikt).</li>
          <li>Tik op 'Locatievoorzieningen' en zorg dat deze is ingeschakeld.</li>
          <li>Herlaad de pagina.</li>
        `;
      default: // Desktop
        if (browser.name.includes("Chrome")) {
          return `
            <li>Klik op het slotje of 'i' icoon in de adresbalk.</li>
            <li>Klik op 'Sitevoorkeuren' of 'Site-instellingen'.</li>
            <li>Bij 'Locatie', kies 'Toestaan'.</li>
            <li>Herlaad de pagina.</li>
          `;
        } else if (browser.name.includes("Firefox")) {
          return `
            <li>Klik op het slotje in de adresbalk.</li>
            <li>Klik op de '>' naast 'Toestemmingen'.</li>
            <li>Bij 'Toegang tot je locatie', selecteer 'Toestaan'.</li>
            <li>Herlaad de pagina.</li>
          `;
        } else if (browser.name.includes("Safari")) {
          return `
            <li>Klik op Safari in de menubalk en kies 'Voorkeuren'.</li>
            <li>Ga naar het tabblad 'Websites' en klik op 'Locatie'.</li>
            <li>Zoek naar deze website en kies 'Toestaan'.</li>
            <li>Herlaad de pagina.</li>
          `;
        } else if (browser.name.includes("Edge")) {
          return `
            <li>Klik op het slotje in de adresbalk.</li>
            <li>Klik op 'Toestemmingen voor deze site'.</li>
            <li>Zet 'Locatie' op 'Toestaan'.</li>
            <li>Herlaad de pagina.</li>
          `;
        } else {
          return `
            <li>Zoek naar het slotje of instellingen in de adresbalk.</li>
            <li>Zoek naar locatie-instellingen voor deze website.</li>
            <li>Geef toestemming voor het delen van je locatie.</li>
            <li>Herlaad de pagina.</li>
          `;
        }
    }
  }

  /**
   * Show notification to user with type and auto-dismiss
   * Only one notification of each type will be shown at a time
   */
  showNotification(message, type = 'info', duration = 4000) {
    // Cancel any existing notification of the same type
    if (this.state.activeNotifications[type]) {
      clearTimeout(this.state.activeNotifications[type].timeout);
      if (this.state.activeNotifications[type].element) {
        this.state.activeNotifications[type].element.remove();
      }
    }
    
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `geolocation-notification notification-${type}`;
    
    // Add icon based on type
    let icon = '';
    switch(type) {
      case 'error':
        icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
        break;
      case 'success':
        icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 12l2 2 6-6"></path></svg>';
        break;
      default: // info
        icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="8"></line></svg>';
    }
    
    notification.innerHTML = `
      <div class="notification-icon">${icon}</div>
      <div class="notification-message">${message}</div>
    `;
    
    document.body.appendChild(notification);
    
    // Add progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'notification-progress';
    notification.appendChild(progressBar);
    
    // Animate progress bar
    progressBar.style.transition = `transform ${duration}ms linear`;
    progressBar.style.transform = 'scaleX(1)';
    
    // Force reflow
    notification.offsetHeight;
    
    // Start animation
    progressBar.style.transform = 'scaleX(0)';
    
    // Track this notification
    const timeoutId = setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transform = 'translateX(-50%) translateY(-20px)';
      
      setTimeout(() => {
        notification.remove();
        // Remove from tracking
        if (this.state.activeNotifications[type] && 
            this.state.activeNotifications[type].element === notification) {
          delete this.state.activeNotifications[type];
        }
      }, 300);
    }, duration);
    
    // Store reference for potential early removal
    this.state.activeNotifications[type] = {
      element: notification,
      timeout: timeoutId
    };
  }

  /**
   * Show boundary popup with improved design when user is outside boundary
   */
  showBoundaryPopup(userPosition) {
    // Remove existing popup if any
    const existingPopup = document.querySelector(".location-boundary-popup");
    if (existingPopup) existingPopup.remove();

    // Calculate direction to center
    const direction = this.geoManager.getDirectionToCenterText(userPosition);
    
    // Create popup element
    const popupElement = this.createBoundaryPopupElement(userPosition, direction);
    document.body.appendChild(popupElement.popup);
    
    // Animate map preview
    this.animateBoundaryMapPreview(popupElement.mapPreview, userPosition);
    
    // Highlight boundary
    this.highlightBoundary();
    
    // Fly to center with overview
    this.map.flyTo({
      center: this.config.boundary.centerPoint,
      zoom: 13.5,
      pitch: 0,
      bearing: 0,
      duration: 1500
    });
    
    // Show popup with animation
    popupElement.popup.style.transition = "none";
    popupElement.popup.style.transform = "translateX(-50%) translateY(100%)";
    
    // Force reflow
    popupElement.popup.offsetHeight;
    
    // Animate in
    popupElement.popup.style.transition = "transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)";
    popupElement.popup.style.transform = "translateX(-50%) translateY(0)";
  }
  
  /**
   * Create boundary popup element
   */
  createBoundaryPopupElement(userPosition, direction) {
    // Create popup
    const popup = document.createElement("div");
    popup.className = "location-boundary-popup";
    
    const heading = document.createElement("h3");
    heading.textContent = "Kom naar Heerlen Centrum";
    
    const text = document.createElement("p");
    text.innerHTML = `Deze functie is alleen beschikbaar binnen de blauwe cirkel op de kaart. Je bent ongeveer <strong>${this.geoManager.getDistanceToCenter(userPosition).toFixed(1)}km</strong> verwijderd van het centrum van Heerlen.<br><br><span class="direction-text">Ga naar ${direction} om het interactieve gebied te bereiken!</span>`;
    
    const button = document.createElement("button");
    button.textContent = "Ik kom er aan!";
    
    // Add direction arrow
    const directionArrow = document.createElement("div");
    directionArrow.className = "direction-arrow";
    directionArrow.style.transform = `rotate(${this.geoManager.getDirectionToCenterAngle(userPosition)}deg)`;
    
    // Handle button click
    button.addEventListener("click", () => {
      if (window.innerWidth <= 768) {
        popup.style.transform = "translateY(100%)";
      } else {
        popup.style.transform = "translateX(120%)";
      }
      
      setTimeout(() => {
        popup.remove();
      }, 600);
      
      setTimeout(() => {
        this.geoManager.visualization.hideBoundaryLayers();
      }, 200);
    });
    
    // Add map preview
    const mapPreview = document.createElement("div");
    mapPreview.className = "boundary-map-preview";
    
    // Assemble popup
    popup.appendChild(directionArrow);
    popup.appendChild(heading);
    popup.appendChild(text);
    popup.appendChild(mapPreview);
    popup.appendChild(button);
    
    return { popup, mapPreview, button, directionArrow };
  }
  
  /**
   * Highlight boundary temporarily
   */
  highlightBoundary() {
    if (this.map.getLayer("boundary-fill")) {
      this.map.setPaintProperty("boundary-fill", "fill-opacity", 0.08);
      this.map.setPaintProperty("boundary-line", "line-width", 4);
      
      setTimeout(() => {
        this.map.setPaintProperty("boundary-fill", "fill-opacity", 0.03);
        this.map.setPaintProperty("boundary-line", "line-width", 2);
      }, 2000);
    }
  }
  
  /**
   * Animate the boundary map preview
   */
  animateBoundaryMapPreview(previewEl, userPosition) {
    // Calculate angle from user to center
    const angle = this.geoManager.getDirectionToCenterAngle(userPosition);
    
    // Position user dot (before element) based on angle and distance
    const distance = this.geoManager.getDistanceToCenter(userPosition);
    const maxDistance = this.config.boundary.radius * 3; // Max for positioning
    const normalizedDistance = Math.min(distance, maxDistance) / maxDistance;
    
    // Calculate position (closer to edge for further distances)
    const posX = 50 - Math.cos((angle - 90) * Math.PI / 180) * 40 * normalizedDistance;
    const posY = 50 - Math.sin((angle - 90) * Math.PI / 180) * 40 * normalizedDistance;
    
    previewEl.style.setProperty('--user-x', `${posX}%`);
    previewEl.style.setProperty('--user-y', `${posY}%`);
    
    // Add elements
    const pulse = document.createElement('div');
    pulse.className = 'pulse';
    
    const path = document.createElement('div');
    path.className = 'path';
    path.style.transform = `rotate(${angle}deg)`;
    
    const centerDot = document.createElement('div');
    centerDot.className = 'center-dot';
    
    previewEl.appendChild(pulse);
    previewEl.appendChild(path);
    previewEl.appendChild(centerDot);
  }
  
  /**
   * Apply pulsing animation to an element
   */
  pulseElement(element) {
    element.classList.add('pulse-animation');
    
    // Remove class after animation
    setTimeout(() => {
      element.classList.remove('pulse-animation');
    }, 800);
  }
}

/**
 * Visualization Manager - Handles all map visuals and layers
 */
class VisualizationManager {
  constructor(geoManager) {
    this.geoManager = geoManager;
    this.map = geoManager.map;
    this.config = geoManager.config;
  }
  
  /**
   * Setup search radius visualization with improved appearance
   */
  setupSearchRadius() {
    this.map.on("load", () => {
      // Setup inner radius
      this.map.addSource(this.config.radius.searchId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[]] }
        }
      });
      
      this.map.addLayer({
        id: this.config.radius.searchId,
        type: "fill-extrusion",
        source: this.config.radius.searchId,
        paint: {
          "fill-extrusion-color": "#4B83F2",
          "fill-extrusion-opacity": 0.15,
          "fill-extrusion-height": 3,
          "fill-extrusion-base": 0
        }
      });

      // Setup outer radius
      this.map.addSource(this.config.radius.outerSearchId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[]] }
        }
      });
      
      this.map.addLayer({
        id: this.config.radius.outerSearchId,
        type: "fill-extrusion",
        source: this.config.radius.outerSearchId,
        paint: {
          "fill-extrusion-color": "#4B83F2",
          "fill-extrusion-opacity": 0.05,
          "fill-extrusion-height": 1.5,
          "fill-extrusion-base": 0
        }
      });
      
      // Add border radius
      this.map.addSource(`${this.config.radius.searchId}-border`, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[]] }
        }
      });
      
      this.map.addLayer({
        id: `${this.config.radius.searchId}-border`,
        type: "line",
        source: `${this.config.radius.searchId}-border`,
        paint: {
          "line-color": "#4B83F2",
          "line-width": 2,
          "line-opacity": 0.5,
          "line-dasharray": [2, 2]
        }
      });
      
      // Add radius indicator text
      this.map.addSource(`${this.config.radius.searchId}-text`, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            text: `${this.config.radius.inMeters}m`
          }
        }
      });
      
      this.map.addLayer({
        id: `${this.config.radius.searchId}-text`,
        type: "symbol",
        source: `${this.config.radius.searchId}-text`,
        layout: {
          "text-field": "{text}",
          "text-size": 12,
          "text-offset": [0, 0],
          "text-anchor": "center",
          "text-allow-overlap": true
        },
        paint: {
          "text-color": "#4B83F2",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2
        }
      });
    });
  }

  /**
   * Setup boundary circle visualization with clearer visuals
   */
  setupBoundaryCheck() {
    this.map.on("load", () => {
      this.map.addSource("boundary-circle", {
        type: "geojson",
        data: this.geoManager.createBoundaryCircle()
      });
      
      // Fill layer
      this.map.addLayer({
        id: "boundary-fill",
        type: "fill",
        source: "boundary-circle",
        paint: { 
          "fill-color": "#4B83F2", 
          "fill-opacity": 0.03 
        },
        layout: { 
          visibility: "none" 
        }
      });
      
      // Border layer
      this.map.addLayer({
        id: "boundary-line",
        type: "line",
        source: "boundary-circle",
        paint: {
          "line-color": "#4B83F2",
          "line-width": 2,
          "line-dasharray": [3, 3]
        },
        layout: { 
          visibility: "none" 
        }
      });
      
      // Boundary label layer
      this.map.addLayer({
        id: "boundary-label",
        type: "symbol",
        source: "boundary-circle",
        layout: {
          "text-field": "Heerlen Centrum",
          "text-size": 14,
          "text-offset": [0, 0],
          "text-anchor": "center",
          "text-allow-overlap": true,
          "visibility": "none"
        },
        paint: {
          "text-color": "#4B83F2",
          "text-halo-color": "rgba(255, 255, 255, 0.8)",
          "text-halo-width": 2
        }
      });
    });
  }

  /**
   * Show boundary visualization with enhanced animation
   */
  showBoundaryLayers() {
    this.config.boundary.layerIds.forEach(layerId => {
      if (this.map.getLayer(layerId)) {
        this.map.setLayoutProperty(layerId, "visibility", "visible");
        
        if (layerId === "boundary-fill") {
          // Animate fill opacity
          let opacity = 0;
          const animateOpacity = () => {
            if (opacity < 0.03) {
              opacity += 0.005;
              this.map.setPaintProperty(layerId, "fill-opacity", opacity);
              requestAnimationFrame(animateOpacity);
            }
          };
          animateOpacity();
        }
        
        if (layerId === "boundary-line") {
          // Animate line width
          let width = 0;
          const animateWidth = () => {
            if (width < 2) {
              width += 0.2;
              this.map.setPaintProperty(layerId, "line-width", width);
              requestAnimationFrame(animateWidth);
            }
          };
          animateWidth();
        }
      }
    });
  }

  /**
   * Hide boundary visualization with smooth animation
   */
  hideBoundaryLayers() {
    this.config.boundary.layerIds.forEach(layerId => {
      if (this.map.getLayer(layerId)) {
        if (layerId === "boundary-fill") {
          // Animate fill opacity
          let opacity = 0.03;
          const animateOpacity = () => {
            if (opacity > 0) {
              opacity -= 0.005;
              this.map.setPaintProperty(layerId, "fill-opacity", opacity);
              requestAnimationFrame(animateOpacity);
            } else {
              this.map.setLayoutProperty(layerId, "visibility", "none");
            }
          };
          animateOpacity();
        } else if (layerId === "boundary-line") {
          // Animate line width
          let width = 2;
          const animateWidth = () => {
            if (width > 0) {
              width -= 0.2;
              this.map.setPaintProperty(layerId, "line-width", width);
              requestAnimationFrame(animateWidth);
            } else {
              this.map.setLayoutProperty(layerId, "visibility", "none");
            }
          };
          animateWidth();
        } else {
          this.map.setLayoutProperty(layerId, "visibility", "none");
        }
      }
    });
  }

  /**
   * Update search radius visualization around user with enhanced appearance
   */
  updateSearchRadius(center) {
    if (!this.map.getSource(this.config.radius.searchId)) return;

    // Generate circles
    const circles = this.generateSearchCircles(center);
    
    // Update radius layers
    this.map.getSource(this.config.radius.searchId).setData({
      type: "Feature",
      geometry: { 
        type: "Polygon", 
        coordinates: [circles.inner] 
      }
    });
    
    this.map.getSource(this.config.radius.outerSearchId).setData({
      type: "Feature",
      geometry: { 
        type: "Polygon", 
        coordinates: [circles.outer] 
      }
    });
    
    // Update border
    this.map.getSource(`${this.config.radius.searchId}-border`).setData({
      type: "Feature",
      geometry: { 
        type: "Polygon", 
        coordinates: [circles.inner] 
      }
    });
    
    // Update text position and value
    this.map.getSource(`${this.config.radius.searchId}-text`).setData({
      type: "Feature",
      geometry: { 
        type: "Point", 
        coordinates: [center[0], center[1] + this.degreesToLatitude(this.config.radius.inMeters / 1000) * 0.9] 
      },
      properties: {
        text: `${this.config.radius.inMeters}m zoekgebied`
      }
    });
  }
  
  /**
   * Generate search radius circles with natural variation
   */
  generateSearchCircles(center) {
    const point = { 
      latitude: center[1], 
      longitude: center[0] 
    };
    
    const radiusKm = this.config.radius.inMeters / 1000;
    const outerRadiusKm = this.config.radius.maxInMeters / 1000;
    const points = [];
    const outerPoints = [];
    const pointCount = 64;

    // Convert km to degrees based on latitude
    const degreesLongPerKm = radiusKm / (111.32 * Math.cos(point.latitude * Math.PI / 180));
    const degreesLatPerKm = radiusKm / 110.574;
    
    const outerDegreesLongPerKm = outerRadiusKm / (111.32 * Math.cos(point.latitude * Math.PI / 180));
    const outerDegreesLatPerKm = outerRadiusKm / 110.574;

    // Generate points around the circle with slight randomization for natural look
    for (let i = 0; i <= pointCount; i++) {
      const angle = (i / pointCount) * (2 * Math.PI);
      
      // Inner radius points
      const variation = 1 + (Math.random() * 0.03 - 0.015); // ±1.5% variation
      const dx = degreesLongPerKm * Math.cos(angle) * variation;
      const dy = degreesLatPerKm * Math.sin(angle) * variation;
      points.push([point.longitude + dx, point.latitude + dy]);
      
      // Outer radius points
      const outerDx = outerDegreesLongPerKm * Math.cos(angle) * variation;
      const outerDy = outerDegreesLatPerKm * Math.sin(angle) * variation;
      outerPoints.push([point.longitude + outerDx, point.latitude + outerDy]);
    }

    // Return both sets of points
    return { inner: points, outer: outerPoints };
  }
  
  /**
   * Convert degrees to latitude
   */
  degreesToLatitude(km) {
    return km / 110.574;
  }

  /**
   * Clear search radius visualization
   */
  clearSearchRadius() {
    if (this.map.getSource(this.config.radius.searchId)) {
      // Clear all radius-related sources
      [
        this.config.radius.searchId, 
        this.config.radius.outerSearchId, 
        `${this.config.radius.searchId}-border`,
        `${this.config.radius.searchId}-text`
      ].forEach(sourceId => {
        if (this.map.getSource(sourceId)) {
          const emptyData = sourceId.includes('text') 
            ? { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } }
            : { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] } };
            
          this.map.getSource(sourceId).setData(emptyData);
        }
      });
    }
  }
}

// Initialize geolocation manager
const geolocationManager = new GeolocationManager(map);
window.geolocationManager = geolocationManager;

//! ============= DATA LOADING =============
/**
 * Load location data from CMS
 */
function getGeoData() {
  document.getElementById("location-list").childNodes.forEach((element, index) => {
    const locationData = {
      name: element.querySelector("#name").value,
      locationID: element.querySelector("#locationID").value,
      locationInfo: element.querySelector(".locations-map_card").innerHTML,
      locationLat: parseFloat(element.querySelector("#locationLatitude").value),
      locationLong: parseFloat(element.querySelector("#locationLongitude").value),
      ondernemerkleur: element.querySelector("#ondernemerkleur").value,
      icon: element.querySelector("#icon").value,
      image: element.querySelector("#image").value,
      category: element.querySelector("#category").value,
      // Contact details
      telefoonummer: element.querySelector("#telefoonnummer").value,
      locatie: element.querySelector("#locatie").value,
      maps: element.querySelector("#maps").value,
      website: element.querySelector("#website").value,
      // Opening hours
      maandag: element.querySelector("#maandag").value,
      dinsdag: element.querySelector("#dinsdag").value,
      woensdag: element.querySelector("#woensdag").value,
      donderdag: element.querySelector("#donderdag").value,
      vrijdag: element.querySelector("#vrijdag").value,
      zaterdag: element.querySelector("#zaterdag").value,
      zondag: element.querySelector("#zondag").value
    };
    
    const feature = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [locationData.locationLong, locationData.locationLat]
      },
      properties: {
        id: locationData.locationID,
        description: locationData.locationInfo,
        arrayID: index,
        color: locationData.ondernemerkleur,
        name: locationData.name,
        icon: locationData.icon,
        image: locationData.image,
        category: locationData.category,
        // Contact details
        telefoonummer: locationData.telefoonummer,
        locatie: locationData.locatie,
        maps: locationData.maps,
        website: locationData.website,
        // Opening hours
        maandag: locationData.maandag,
        dinsdag: locationData.dinsdag,
        woensdag: locationData.woensdag,
        donderdag: locationData.donderdag,
        vrijdag: locationData.vrijdag,
        zaterdag: locationData.zaterdag,
        zondag: locationData.zondag
      }
    };
    
    // Add to locations if not already present
    if (!mapLocations.features.some(feat => feat.properties.id === locationData.locationID)) {
      mapLocations.features.push(feature);
    }
  });
}

/**
 * Load AR location data from CMS
 */
function getARData() {
  document.getElementById("location-ar-list").childNodes.forEach((element, index) => {
    const arData = {
      name_ar: element.querySelector("#name_ar").value,
      slug_ar: element.querySelector("#slug_ar").value,
      latitude_ar: parseFloat(element.querySelector("#latitude_ar").value),
      longitude_ar: parseFloat(element.querySelector("#longitude_ar").value),
      image_ar: element.querySelector("#image_ar").value,
      description_ar: element.querySelector("#description_ar").value,
      link_ar: element.querySelector("#link_ar").value,
      icon_ar: element.querySelector("#icon_ar").value,
      stap1: element.querySelector("#stap1").value,
      stap2: element.querySelector("#stap2").value,
      stap3: element.querySelector("#stap3").value,
      stap4: element.querySelector("#stap4").value,
    };
    
    const feature = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [arData.longitude_ar, arData.latitude_ar]
      },
      properties: {
        type: "ar",
        name: arData.name_ar,
        slug: arData.slug_ar,
        description: arData.description_ar,
        arrayID: index,
        image: arData.image_ar,
        color: "black",
        link_ar: arData.link_ar,
        icon: arData.icon_ar,
        stap1: arData.stap1,
        stap2: arData.stap2,
        stap3: arData.stap3,
        stap4: arData.stap4
      }
    };
    
    mapLocations.features.push(feature);
  });
}

// Load data
getGeoData();
getARData();

//! ============= MARKER MANAGEMENT =============
/**
 * Load marker icons
 */
function loadIcons() {
  // Get unique icons
  const uniqueIcons = [...new Set(mapLocations.features.map(feature => feature.properties.icon))];
  
  // Load each icon
  uniqueIcons.forEach(iconUrl => {
    map.loadImage(iconUrl, (error, image) => {
      if (error) throw error;
      map.addImage(iconUrl, image);
    });
  });
}

/**
 * Add custom markers to map
 */
function addCustomMarkers() {
  if (markersAdded) return;
  
  // Add source
  map.addSource("locations", { 
    type: "geojson", 
    data: mapLocations 
  });
  
  // Add layers
  const layers = [
    // Circle marker layer
    {
      id: "location-markers",
      type: "circle",
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          CONFIG.MARKER_ZOOM.min, 2,
          CONFIG.MARKER_ZOOM.small, 5,
          CONFIG.MARKER_ZOOM.medium, 8,
          CONFIG.MARKER_ZOOM.large, 10
        ],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 0
      }
    },
    // Icon layer
    {
      id: "location-icons",
      type: "symbol",
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          CONFIG.MARKER_ZOOM.min, 0.05,
          CONFIG.MARKER_ZOOM.small, 0.08,
          CONFIG.MARKER_ZOOM.medium, 0.12,
          CONFIG.MARKER_ZOOM.large, 0.15
        ],
        "icon-allow-overlap": true,
        "icon-anchor": "center"
      },
      paint: { 
        "icon-opacity": 0 
      }
    },
    // Label layer
    {
      id: "location-labels",
      type: "symbol",
      layout: {
        "text-field": ["get", "name"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          CONFIG.MARKER_ZOOM.min, 8,
          CONFIG.MARKER_ZOOM.small, 10,
          CONFIG.MARKER_ZOOM.medium, 11,
          CONFIG.MARKER_ZOOM.large, 12
        ],
        "text-offset": [0, 1],
        "text-anchor": "top",
        "text-allow-overlap": false
      },
      paint: {
        "text-color": ["get", "color"],
        "text-halo-color": "#ffffff",
        "text-halo-width": 2,
        "text-opacity": 0
      }
    }
  ];
  
  // Add each layer
  layers.forEach(layer => map.addLayer({ ...layer, source: "locations" }));
  
  // Animate marker appearance
  let opacity = 0;
  const animateMarkers = () => {
    opacity += 0.1;
    map.setPaintProperty("location-markers", "circle-opacity", opacity);
    map.setPaintProperty("location-icons", "icon-opacity", opacity);
    map.setPaintProperty("location-labels", "text-opacity", opacity);
    
    if (opacity < 1) {
      requestAnimationFrame(animateMarkers);
    }
  };
  
  setTimeout(animateMarkers, 100);
  markersAdded = true;
}

// Setup marker hover effects
map.on("mouseenter", "location-markers", () => {
  map.getCanvas().style.cursor = "pointer";
});

map.on("mouseleave", "location-markers", () => {
  map.getCanvas().style.cursor = "";
});

// ============= MARKER FILTERING =============
const activeFilters = new Set();

/**
 * Setup location filter buttons
 */
function setupLocationFilters() {
  document.querySelectorAll(".filter-btn").forEach(button => {
    button.addEventListener("click", () => {
      const category = button.dataset.category;
      button.classList.toggle("is--active");
      
      if (activeFilters.has(category)) {
        activeFilters.delete(category);
      } else {
        activeFilters.add(category);
      }
      
      applyMapFilters();
    });
  });
}

/**
 * Apply active filters to map markers
 */
function applyMapFilters() {
  // If no filters active, show all markers
  if (activeFilters.size === 0) {
    map.setFilter("location-markers", null);
    map.setFilter("location-icons", null);
    map.setFilter("location-labels", null);
    return;
  }
  
  // Create filter to show only markers with selected categories
  const filter = ["in", ["get", "category"], ["literal", Array.from(activeFilters)]];
  
  // Apply filter to all marker layers
  map.setFilter("location-markers", filter);
  map.setFilter("location-icons", filter);
  map.setFilter("location-labels", filter);
}

//! ============= POPUP MANAGEMENT =============
/**
 * Create popup content based on feature properties
 */
function createPopupContent(properties) {
  const isAR = properties.type === "ar";
  
  // Common styles
  const styles = `
    <style>
      .popup-side {
        background-color: ${properties.color || "#6B46C1"};
        clip-path: polygon(calc(100% - 0px) 26.5px, calc(100% - 0px) calc(100% - 26.5px), calc(100% - 0px) calc(100% - 26.5px), calc(100% - 0.34671999999995px) calc(100% - 22.20048px), calc(100% - 1.3505599999999px) calc(100% - 18.12224px), calc(100% - 2.95704px) calc(100% - 14.31976px), calc(100% - 5.11168px) calc(100% - 10.84752px), calc(100% - 7.76px) calc(100% - 7.76px), calc(100% - 10.84752px) calc(100% - 5.11168px), calc(100% - 14.31976px) calc(100% - 2.9570399999999px), calc(100% - 18.12224px) calc(100% - 1.35056px), calc(100% - 22.20048px) calc(100% - 0.34672px), calc(100% - 26.5px) calc(100% - 0px), calc(50% - -32.6px) calc(100% - 0px), calc(50% - -32.6px) calc(100% - 0px), calc(50% - -31.57121px) calc(100% - 0.057139999999947px), calc(50% - -30.56648px) calc(100% - 0.2255199999999px), calc(50% - -29.59427px) calc(100% - 0.50057999999996px), calc(50% - -28.66304px) calc(100% - 0.87775999999991px), calc(50% - -27.78125px) calc(100% - 1.3525px), calc(50% - -26.95736px) calc(100% - 1.92024px), calc(50% - -26.19983px) calc(100% - 2.57642px), calc(50% - -25.51712px) calc(100% - 3.31648px), calc(50% - -24.91769px) calc(100% - 4.13586px), calc(50% - -24.41px) calc(100% - 5.03px), calc(50% - -24.41px) calc(100% - 5.03px), calc(50% - -22.95654px) calc(100% - 7.6045699999999px), calc(50% - -21.23752px) calc(100% - 9.9929599999998px), calc(50% - -19.27298px) calc(100% - 12.17519px), calc(50% - -17.08296px) calc(100% - 14.13128px), calc(50% - -14.6875px) calc(100% - 15.84125px), calc(50% - -12.10664px) calc(100% - 17.28512px), calc(50% - -9.36042px) calc(100% - 18.44291px), calc(50% - -6.46888px) calc(100% - 19.29464px), calc(50% - -3.45206px) calc(100% - 19.82033px), calc(50% - -0.32999999999998px) calc(100% - 20px), calc(50% - -0.32999999999998px) calc(100% - 20px), calc(50% - 2.79179px) calc(100% - 19.82033px), calc(50% - 5.8079199999999px) calc(100% - 19.29464px), calc(50% - 8.69853px) calc(100% - 18.44291px), calc(50% - 11.44376px) calc(100% - 17.28512px), calc(50% - 14.02375px) calc(100% - 15.84125px), calc(50% - 16.41864px) calc(100% - 14.13128px), calc(50% - 18.60857px) calc(100% - 12.17519px), calc(50% - 20.57368px) calc(100% - 9.9929599999999px), calc(50% - 22.29411px) calc(100% - 7.60457px), calc(50% - 23.75px) calc(100% - 5.03px), calc(50% - 23.75px) calc(100% - 5.03px), calc(50% - 24.25769px) calc(100% - 4.1358599999999px), calc(50% - 24.85712px) calc(100% - 3.3164799999998px), calc(50% - 25.53983px) calc(100% - 2.57642px), calc(50% - 26.29736px) calc(100% - 1.92024px), calc(50% - 27.12125px) calc(100% - 1.3525px), calc(50% - 28.00304px) calc(100% - 0.87775999999997px), calc(50% - 28.93427px) calc(100% - 0.50057999999996px), calc(50% - 29.90648px) calc(100% - 0.22552000000002px), calc(50% - 30.91121px) calc(100% - 0.057140000000004px), calc(50% - 31.94px) calc(100% - 0px), 26.5px calc(100% - 0px), 26.5px calc(100% - 0px), 22.20048px calc(100% - 0.34671999999989px), 18.12224px calc(100% - 1.3505599999999px), 14.31976px calc(100% - 2.95704px), 10.84752px calc(100% - 5.1116799999999px), 7.76px calc(100% - 7.76px), 5.11168px calc(100% - 10.84752px), 2.95704px calc(100% - 14.31976px), 1.35056px calc(100% - 18.12224px), 0.34672px calc(100% - 22.20048px), 4.3855735949631E-31px calc(100% - 26.5px), 0px 26.5px, 0px 26.5px, 0.34672px 22.20048px, 1.35056px 18.12224px, 2.95704px 14.31976px, 5.11168px 10.84752px, 7.76px 7.76px, 10.84752px 5.11168px, 14.31976px 2.95704px, 18.12224px 1.35056px, 22.20048px 0.34672px, 26.5px 4.3855735949631E-31px, calc(50% - 26.74px) 0px, calc(50% - 26.74px) 0px, calc(50% - 25.31263px) 0.07137px, calc(50% - 23.91544px) 0.28176px, calc(50% - 22.55581px) 0.62559px, calc(50% - 21.24112px) 1.09728px, calc(50% - 19.97875px) 1.69125px, calc(50% - 18.77608px) 2.40192px, calc(50% - 17.64049px) 3.22371px, calc(50% - 16.57936px) 4.15104px, calc(50% - 15.60007px) 5.17833px, calc(50% - 14.71px) 6.3px, calc(50% - 14.71px) 6.3px, calc(50% - 13.6371px) 7.64798px, calc(50% - 12.446px) 8.89024px, calc(50% - 11.1451px) 10.01826px, calc(50% - 9.7428px) 11.02352px, calc(50% - 8.2475px) 11.8975px, calc(50% - 6.6676px) 12.63168px, calc(50% - 5.0115px) 13.21754px, calc(50% - 3.2876px) 13.64656px, calc(50% - 1.5043px) 13.91022px, calc(50% - -0.32999999999996px) 14px, calc(50% - -0.32999999999998px) 14px, calc(50% - -2.16431px) 13.9105px, calc(50% - -3.94768px) 13.6476px, calc(50% - -5.67177px) 13.2197px, calc(50% - -7.32824px) 12.6352px, calc(50% - -8.90875px) 11.9025px, calc(50% - -10.40496px) 11.03px, calc(50% - -11.80853px) 10.0261px, calc(50% - -13.11112px) 8.8992px, calc(50% - -14.30439px) 7.6577px, calc(50% - -15.38px) 6.31px, calc(50% - -15.38px) 6.31px, calc(50% - -16.27279px) 5.18562px, calc(50% - -17.25432px) 4.15616px, calc(50% - -18.31733px) 3.22714px, calc(50% - -19.45456px) 2.40408px, calc(50% - -20.65875px) 1.6925px, calc(50% - -21.92264px) 1.09792px, calc(50% - -23.23897px) 0.62586px, calc(50% - -24.60048px) 0.28184px, calc(50% - -25.99991px) 0.07138px, calc(50% - -27.43px) 8.9116630386686E-32px, calc(100% - 26.5px) 0px, calc(100% - 26.5px) 0px, calc(100% - 22.20048px) 0.34672px, calc(100% - 18.12224px) 1.35056px, calc(100% - 14.31976px) 2.95704px, calc(100% - 10.84752px) 5.11168px, calc(100% - 7.76px) 7.76px, calc(100% - 5.11168px) 10.84752px, calc(100% - 2.9570399999999px) 14.31976px, calc(100% - 1.35056px) 18.12224px, calc(100% - 0.34671999999995px) 22.20048px, calc(100% - 5.6843418860808E-14px) 26.5px);
      }
      
      .close-button {
        background: ${properties.color || "#6B46C1"};
      }

      
      
      ${isAR ? `
        .ar-button {
          border: 2px solid white;
          font-weight: bold;
        }
        .ar-description {
          font-size: 0.9em;
          margin-top: 10px;
        }
      ` : ""}
    </style>
  `;
  
  // Different HTML structure for AR vs regular locations
  if (isAR) {
    return {
      styles,
      html: `
        <div class="popup-wrapper">
          <button class="close-button" aria-label="Close popup"></button>
          <div class="popup-side popup-front">
            <svg class="popup-border-overlay" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M0 227.13V240.82C0 246.99 5 252 11.18 252H19.2C25.38 252 30.38 246.99 30.38 240.82C30.38 246.99 35.4 252 41.56 252H49.6C55.75 252 60.75 247.01 60.76 240.85C60.79 247.01 65.79 252 71.94 252H79.98C86.15 252 91.16 246.99 91.16 240.82C91.16 246.99 96.16 252 102.34 252H110.36C116.53 252 121.53 247.01 121.54 240.84C121.55 247.01 126.55 252 132.72 252H140.74C146.35 252 150.99 247.87 151.79 242.48C152.6 247.87 157.24 252 162.85 252H170.87C177.04 252 182.04 247 182.05 240.84C182.06 247 187.06 252 193.23 252H201.25C207.03 252 211.78 247.62 212.36 242C212.95 247.62 217.7 252 223.48 252H231.5C237.68 252 242.68 246.99 242.68 240.82C242.68 246.99 247.69 252 253.86 252H261.89C268.05 252 273.05 247.01 273.06 240.85C273.08 247.01 278.08 252 284.24 252H292.27C298.44 252 303.45 246.99 303.45 240.82C303.45 246.99 308.46 252 314.63 252H322.66C328.82 252 333.82 247.01 333.83 240.84C333.85 247.01 338.85 252 345.01 252H353.04C359.21 252 364.22 246.99 364.22 240.82V227.13C364.22 220.95 359.21 215.95 353.04 215.95C359.21 215.95 364.22 210.94 364.22 204.77V191.07C364.22 184.9 359.21 179.89 353.04 179.89C359.21 179.89 364.22 174.89 364.22 168.71V155.02C364.22 149.52 360.25 144.96 355.02 144.03C360.25 143.09 364.22 138.53 364.22 133.03V119.34C364.22 113.17 359.22 108.17 353.06 108.16C359.22 108.16 364.22 103.15 364.22 96.98V83.29C364.22 77.11 359.21 72.11 353.04 72.11C359.21 72.11 364.22 67.1 364.22 60.93V47.23C364.22 41.06 359.21 36.05 353.04 36.05C359.21 36.05 364.22 31.05 364.22 24.87V11.18C364.22 5.01 359.21 0 353.04 0H345.01C338.85 0 333.85 4.99 333.83 11.16C333.82 4.99 328.82 0 322.66 0H314.63C308.46 0 303.45 5.01 303.45 11.18C303.45 5.01 298.44 0 292.27 0H284.24C278.08 0 273.08 4.99 273.06 11.16C273.05 4.99 268.05 0 261.89 0H253.86C247.69 0 242.68 5.01 242.68 11.18C242.68 5.01 237.68 0 231.5 0H223.48C217.7 0 212.95 4.38 212.36 10C211.78 4.38 207.03 0 201.25 0H193.23C187.06 0 182.06 5 182.05 11.16C182.04 5 177.04 0 170.87 0H162.85C157.24 0 152.6 4.13 151.79 9.52C150.99 4.13 146.35 0 140.74 0H132.72C126.55 0 121.55 4.99 121.54 11.16C121.53 4.99 116.53 0 110.36 0H102.34C96.16 0 91.16 5.01 91.16 11.18C91.16 5.01 86.15 0 79.98 0H71.94C65.79 0 60.79 4.99 60.76 11.16C60.75 4.99 55.75 0 49.6 0H41.56C35.4 0 30.38 5.01 30.38 11.18C30.38 5.01 25.38 0 19.2 0H11.18C5 0 0 5.01 0 11.18V24.87C0 31.05 5 36.05 11.18 36.05C5 36.05 0 41.06 0 47.23V60.93C0 67.1 5 72.11 11.18 72.11C5 72.11 0 77.11 0 83.29V96.98C0 103.15 4.99 108.15 11.16 108.16C4.99 108.17 0 113.17 0 119.34V133.03C0 138.53 3.97 143.09 9.19 144.03C3.97 144.96 0 149.52 0 155.02V168.71C0 174.89 5 179.89 11.18 179.89C5 179.89 0 184.9 0 191.07V204.77C0 210.94 5 215.95 11.18 215.95C5 215.95 0 220.95 0 227.13ZM333.83 24.89C333.85 31.06 338.85 36.05 345.01 36.05C338.85 36.05 333.85 41.05 333.83 47.21C333.82 41.05 328.82 36.05 322.66 36.05C328.82 36.05 333.82 31.06 333.83 24.89ZM333.83 60.95C333.85 67.11 338.85 72.11 345.01 72.11C338.85 72.11 333.85 77.1 333.83 83.27C333.82 77.1 328.82 72.11 322.66 72.11C328.82 72.11 333.82 67.11 333.83 60.95ZM333.83 119.32C333.82 113.16 328.83 108.17 322.68 108.16C328.83 108.16 333.82 103.16 333.83 97C333.85 103.16 338.83 108.15 344.99 108.16C338.83 108.17 333.85 113.16 333.83 119.32ZM343.03 144.03C337.81 144.96 333.84 149.51 333.83 155C333.82 149.51 329.86 144.96 324.64 144.03C329.86 143.09 333.82 138.54 333.83 133.05C333.83 138.54 337.81 143.09 343.03 144.03ZM333.83 168.73C333.85 174.9 338.85 179.89 345.01 179.89C338.85 179.89 333.85 184.89 333.83 191.05C333.82 184.89 328.82 179.89 322.66 179.89C328.82 179.89 333.82 174.9 333.83 168.73ZM333.83 204.79C333.85 210.95 338.85 215.95 345.01 215.95C338.85 215.95 333.85 220.94 333.83 227.11C333.82 220.94 328.82 215.95 322.66 215.95C328.82 215.95 333.82 210.95 333.83 204.79ZM303.45 24.87C303.45 31.05 308.46 36.05 314.63 36.05C308.46 36.05 303.45 41.06 303.45 47.23C303.45 41.06 298.44 36.05 292.27 36.05C298.44 36.05 303.45 31.05 303.45 24.87ZM303.45 60.93C303.45 67.1 308.46 72.11 314.63 72.11C308.46 72.11 303.45 77.11 303.45 83.29C303.45 77.11 298.44 72.11 292.27 72.11C298.44 72.11 303.45 67.1 303.45 60.93ZM303.45 119.34C303.45 113.17 298.45 108.17 292.29 108.16C298.45 108.16 303.45 103.15 303.45 96.98C303.45 103.15 308.45 108.15 314.61 108.16C308.45 108.17 303.45 113.17 303.45 119.34ZM312.64 144.03C307.42 144.96 303.45 149.52 303.45 155.02C303.45 149.52 299.48 144.96 294.25 144.03C299.48 143.09 303.45 138.53 303.45 133.03C303.45 138.53 307.42 143.09 312.64 144.03ZM303.45 168.71C303.45 174.89 308.46 179.89 314.63 179.89C308.46 179.89 303.45 184.9 303.45 191.07C303.45 184.9 298.44 179.89 292.27 179.89C298.44 179.89 303.45 174.89 303.45 168.71ZM303.45 204.77C303.45 210.94 308.46 215.95 314.63 215.95C308.46 215.95 303.45 220.95 303.45 227.13C303.45 220.95 298.44 215.95 292.27 215.95C298.44 215.95 303.45 210.94 303.45 204.77ZM273.06 24.9C273.08 31.06 278.08 36.05 284.24 36.05C278.08 36.05 273.08 41.05 273.06 47.21C273.05 41.05 268.05 36.05 261.89 36.05C268.05 36.05 273.05 31.06 273.06 24.9ZM273.06 60.95C273.08 67.11 278.08 72.11 284.24 72.11C278.08 72.11 273.08 77.1 273.06 83.26C273.05 77.1 268.05 72.11 261.89 72.11C268.05 72.11 273.05 67.11 273.06 60.95ZM273.06 119.31C273.05 113.16 268.06 108.17 261.91 108.16C268.06 108.16 273.05 103.16 273.06 97.01C273.08 103.16 278.07 108.15 284.22 108.16C278.07 108.17 273.08 113.16 273.06 119.31ZM282.26 144.03C277.04 144.96 273.08 149.51 273.06 154.99C273.05 149.51 269.09 144.96 263.87 144.03C269.09 143.09 273.05 138.54 273.06 133.06C273.08 138.54 277.04 143.09 282.26 144.03ZM273.06 168.74C273.08 174.9 278.08 179.89 284.24 179.89C278.08 179.89 273.08 184.89 273.06 191.05C273.05 184.89 268.05 179.89 261.89 179.89C268.05 179.89 273.05 174.9 273.06 168.74ZM273.06 204.79C273.08 210.95 278.08 215.95 284.24 215.95C278.08 215.95 273.08 220.94 273.06 227.1C273.05 220.94 268.05 215.95 261.89 215.95C268.05 215.95 273.05 210.95 273.06 204.79ZM242.68 24.87C242.68 31.05 247.69 36.05 253.86 36.05C247.69 36.05 242.68 41.06 242.68 47.23C242.68 41.06 237.68 36.05 231.5 36.05C237.68 36.05 242.68 31.05 242.68 24.87ZM242.68 60.93C242.68 67.1 247.69 72.11 253.86 72.11C247.69 72.11 242.68 77.11 242.68 83.29C242.68 77.11 237.68 72.11 231.5 72.11C237.68 72.11 242.68 67.1 242.68 60.93ZM242.68 119.34C242.68 113.17 237.69 108.17 231.52 108.16C237.69 108.16 242.68 103.15 242.68 96.98C242.68 103.15 247.68 108.15 253.84 108.16C247.68 108.17 242.68 113.17 242.68 119.34ZM251.87 144.03C246.65 144.96 242.68 149.52 242.68 155.02C242.68 149.52 238.71 144.96 233.49 144.03C238.71 143.09 242.68 138.53 242.68 133.03C242.68 138.53 246.65 143.09 251.87 144.03ZM242.68 168.71C242.68 174.89 247.69 179.89 253.86 179.89C247.69 179.89 242.68 184.9 242.68 191.07C242.68 184.9 237.68 179.89 231.5 179.89C237.68 179.89 242.68 174.89 242.68 168.71ZM242.68 204.77C242.68 210.94 247.69 215.95 253.86 215.95C247.69 215.95 242.68 220.95 242.68 227.13C242.68 220.95 237.68 215.95 231.5 215.95C237.68 215.95 242.68 210.94 242.68 204.77ZM212.36 26.05C212.95 31.68 217.7 36.05 223.48 36.05C217.7 36.05 212.95 40.43 212.36 46.05C211.78 40.43 207.03 36.05 201.25 36.05C207.03 36.05 211.78 31.68 212.36 26.05ZM212.36 62.11C212.95 67.73 217.7 72.11 223.48 72.11C217.7 72.11 212.95 76.48 212.36 82.11C211.78 76.48 207.03 72.11 201.25 72.11C207.03 72.11 211.78 67.73 212.36 62.11ZM212.36 118.16C211.78 112.54 207.04 108.17 201.28 108.16C207.04 108.16 211.78 103.78 212.36 98.16C212.95 103.78 217.69 108.15 223.46 108.16C217.69 108.17 212.95 112.54 212.36 118.16ZM221.49 144.03C216.64 144.89 212.88 148.88 212.36 153.85C211.86 148.88 208.1 144.89 203.24 144.03C208.1 143.16 211.86 139.17 212.36 134.2C212.88 139.17 216.64 143.16 221.49 144.03ZM212.36 169.89C212.95 175.52 217.7 179.89 223.48 179.89C217.7 179.89 212.95 184.27 212.36 189.89C211.78 184.27 207.03 179.89 201.25 179.89C207.03 179.89 211.78 175.52 212.36 169.89ZM212.36 205.95C212.95 211.57 217.7 215.95 223.48 215.95C217.7 215.95 212.95 220.32 212.36 225.95C211.78 220.32 207.03 215.95 201.25 215.95C207.03 215.95 211.78 211.57 212.36 205.95ZM182.05 24.89C182.06 31.06 187.06 36.05 193.23 36.05C187.06 36.05 182.06 41.05 182.05 47.22C182.04 41.05 177.04 36.05 170.87 36.05C177.04 36.05 182.04 31.06 182.05 24.89ZM182.05 60.95C182.06 67.11 187.06 72.11 193.23 72.11C187.06 72.11 182.06 77.1 182.05 83.27C182.04 77.1 177.04 72.11 170.87 72.11C177.04 72.11 182.04 67.11 182.05 60.95ZM182.05 119.32C182.04 113.16 177.05 108.17 170.9 108.16C177.05 108.16 182.04 103.16 182.05 97C182.06 103.16 187.05 108.15 193.22 108.16C187.05 108.17 182.06 113.16 182.05 119.32ZM191.24 144.03C186.03 144.96 182.06 149.51 182.05 155C182.04 149.51 178.09 144.96 172.86 144.03C178.09 143.09 182.04 138.54 182.05 133.05C182.06 138.54 186.03 143.09 191.24 144.03ZM182.05 168.73C182.06 174.9 187.06 179.89 193.23 179.89C187.06 179.89 182.06 184.89 182.05 191.05C182.04 184.89 177.04 179.89 170.87 179.89C177.04 179.89 182.04 174.9 182.05 168.73ZM182.05 204.79C182.06 210.95 187.06 215.95 193.23 215.95C187.06 215.95 182.06 220.94 182.05 227.11C182.04 220.94 177.04 215.95 170.87 215.95C177.04 215.95 182.04 210.95 182.05 204.79ZM151.79 26.53C152.6 31.92 157.24 36.05 162.85 36.05C157.24 36.05 152.6 40.18 151.79 45.57C150.99 40.18 146.35 36.05 140.74 36.05C146.35 36.05 150.99 31.92 151.79 26.53ZM151.79 62.59C152.6 67.98 157.24 72.11 162.85 72.11C157.24 72.11 152.6 76.24 151.79 81.63C150.99 76.24 146.35 72.11 140.74 72.11C146.35 72.11 150.99 67.98 151.79 62.59ZM151.79 117.68C151 112.3 146.36 108.17 140.76 108.16C146.36 108.16 151 104.02 151.79 98.64C152.6 104.02 157.23 108.15 162.84 108.16C157.23 108.17 152.6 112.3 151.79 117.68ZM160.86 144.03C156.18 144.86 152.5 148.62 151.79 153.35C151.1 148.62 147.41 144.86 142.73 144.03C147.41 143.19 151.1 139.43 151.79 134.7C152.5 139.43 156.18 143.19 160.86 144.03ZM151.79 170.37C152.6 175.76 157.24 179.89 162.85 179.89C157.24 179.89 152.6 184.02 151.79 189.41C150.99 184.02 146.35 179.89 140.74 179.89C146.35 179.89 150.99 175.76 151.79 170.37ZM151.79 206.43C152.6 211.82 157.24 215.95 162.85 215.95C157.24 215.95 152.6 220.08 151.79 225.47C150.99 220.08 146.35 215.95 140.74 215.95C146.35 215.95 150.99 211.82 151.79 206.43ZM121.54 24.89C121.55 31.06 126.55 36.05 132.72 36.05C126.55 36.05 121.55 41.05 121.54 47.21C121.53 41.05 116.53 36.05 110.36 36.05C116.53 36.05 121.53 31.06 121.54 24.89ZM121.54 60.95C121.55 67.11 126.55 72.11 132.72 72.11C126.55 72.11 121.55 77.1 121.54 83.27C121.53 77.1 116.53 72.11 110.36 72.11C116.53 72.11 121.53 67.11 121.54 60.95ZM121.54 119.32C121.53 113.16 116.54 108.17 110.38 108.16C116.54 108.16 121.53 103.16 121.54 97C121.55 103.16 126.54 108.15 132.69 108.16C126.54 108.17 121.55 113.16 121.54 119.32ZM130.73 144.03C125.51 144.96 121.54 149.51 121.54 155C121.53 149.51 117.56 144.96 112.35 144.03C117.56 143.09 121.53 138.54 121.54 133.05C121.54 138.54 125.51 143.09 130.73 144.03ZM121.54 168.73C121.55 174.9 126.55 179.89 132.72 179.89C126.55 179.89 121.55 184.89 121.54 191.05C121.53 184.89 116.53 179.89 110.36 179.89C116.53 179.89 121.53 174.9 121.54 168.73ZM121.54 204.79C121.55 210.95 126.55 215.95 132.72 215.95C126.55 215.95 121.55 220.94 121.54 227.11C121.53 220.94 116.53 215.95 110.36 215.95C116.53 215.95 121.53 210.95 121.54 204.79ZM91.16 24.87C91.16 31.05 96.16 36.05 102.34 36.05C96.16 36.05 91.16 41.06 91.16 47.23C91.16 41.06 86.15 36.05 79.98 36.05C86.15 36.05 91.16 31.05 91.16 24.87ZM91.16 60.93C91.16 67.1 96.16 72.11 102.34 72.11C96.16 72.11 91.16 77.11 91.16 83.29C91.16 77.11 86.15 72.11 79.98 72.11C86.15 72.11 91.16 67.1 91.16 60.93ZM91.16 119.34C91.16 113.17 86.16 108.17 79.99 108.16C86.16 108.16 91.16 103.15 91.16 96.98C91.16 103.15 96.16 108.15 102.31 108.16C96.16 108.17 91.16 113.17 91.16 119.34ZM100.35 144.03C95.12 144.96 91.16 149.52 91.16 155.02C91.16 149.52 87.18 144.96 81.95 144.03C87.18 143.09 91.16 138.53 91.16 133.03C91.16 138.53 95.12 143.09 100.35 144.03ZM91.16 168.71C91.16 174.89 96.16 179.89 102.34 179.89C96.16 179.89 91.16 184.9 91.16 191.07C91.16 184.9 86.15 179.89 79.98 179.89C86.15 179.89 91.16 174.89 91.16 168.71ZM91.16 204.77C91.16 210.94 96.16 215.95 102.34 215.95C96.16 215.95 91.16 220.95 91.16 227.13C91.16 220.95 86.15 215.95 79.98 215.95C86.15 215.95 91.16 210.94 91.16 204.77ZM60.76 24.9C60.79 31.06 65.79 36.05 71.94 36.05C65.79 36.05 60.79 41.05 60.76 47.21C60.75 41.05 55.75 36.05 49.6 36.05C55.75 36.05 60.75 31.06 60.76 24.9ZM60.76 60.95C60.79 67.11 65.79 72.11 71.94 72.11C65.79 72.11 60.79 77.1 60.76 83.26C60.75 77.1 55.75 72.11 49.6 72.11C55.75 72.11 60.75 67.11 60.76 60.95ZM60.76 119.31C60.75 113.16 55.76 108.17 49.61 108.16C55.76 108.16 60.75 103.16 60.76 97.01C60.79 103.16 65.78 108.15 71.92 108.16C65.78 108.17 60.79 113.16 60.76 119.31ZM69.97 144.03C64.74 144.96 60.79 149.51 60.76 154.99C60.75 149.51 56.79 144.96 51.57 144.03C56.79 143.09 60.75 138.54 60.76 133.06C60.79 138.54 64.74 143.09 69.97 144.03ZM60.76 168.74C60.79 174.9 65.79 179.89 71.94 179.89C65.79 179.89 60.79 184.89 60.76 191.05C60.75 184.89 55.75 179.89 49.6 179.89C55.75 179.89 60.75 174.9 60.76 168.74ZM60.76 204.79C60.79 210.95 65.79 215.95 71.94 215.95C65.79 215.95 60.79 220.94 60.76 227.1C60.75 220.94 55.75 215.95 49.6 215.95C55.75 215.95 60.75 210.95 60.76 204.79ZM30.38 24.87C30.38 31.05 35.4 36.05 41.56 36.05C35.4 36.05 30.38 41.06 30.38 47.23C30.38 41.06 25.38 36.05 19.2 36.05C25.38 36.05 30.38 31.05 30.38 24.87ZM30.38 60.93C30.38 67.1 35.4 72.11 41.56 72.11C35.4 72.11 30.38 77.11 30.38 83.29C30.38 77.11 25.38 72.11 19.2 72.11C25.38 72.11 30.38 67.1 30.38 60.93ZM30.38 119.34C30.38 113.17 25.4 108.17 19.23 108.16C25.4 108.16 30.38 103.15 30.38 96.98C30.38 103.15 35.38 108.15 41.54 108.16C35.38 108.17 30.38 113.17 30.38 119.34ZM39.57 144.03C34.35 144.96 30.38 149.52 30.38 155.02C30.38 149.52 26.41 144.96 21.19 144.03C26.41 143.09 30.38 138.53 30.38 133.03C30.38 138.53 34.35 143.09 39.57 144.03ZM30.38 168.71C30.38 174.89 35.4 179.89 41.56 179.89C35.4 179.89 30.38 184.9 30.38 191.07C30.38 184.9 25.38 179.89 19.2 179.89C25.38 179.89 30.38 174.89 30.38 168.71ZM30.38 204.77C30.38 210.94 35.4 215.95 41.56 215.95C35.4 215.95 30.38 220.95 30.38 227.13C30.38 220.95 25.38 215.95 19.2 215.95C25.38 215.95 30.38 210.94 30.38 204.77Z" fill="url(#paint0_linear_3248_5)"/>
              <defs>
                <linearGradient id="paint0_linear_3248_5" x1="182.11" y1="0" x2="182.11" y2="252" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="${properties.color}" stop-opacity="0" />
                  <stop offset="0.3" stop-color="${properties.color}" stop-opacity="1" />
                </linearGradient>
              </defs>
            </svg>
            ${properties.image ? `<img src="${properties.image}" class="popup-background-image" alt="">` : ""}
            <div class="content-wrapper">
              <div class="popup-title">${properties.name}</div>
              <div class="popup-description">${properties.description}</div>
              ${properties.image ? `<button class="impressie-button button-base" onclick="window.open('${properties.link_ar}', '_blank')">Start AR</button>` : ""}
              <button class="more-info-button button-base">Instructie</button>
            </div>
          </div>
          
          <div class="popup-side popup-back">
            <div class="content-wrapper">
              <div class="popup-title details">Instructie</div>
              <div class="info-content">
                <div class="experience-steps">
                  <div class="experience-step">
                    <h2 class="experience-step-title">STAP 1</h2>
                    <p class="experience-step-text">${properties.stap1}</p>
                  </div>
                  
                  <div class="experience-step">
                    <h2 class="experience-step-title">STAP 2</h2>
                    <p class="experience-step-text">${properties.stap2}</p>
                  </div>
                  
                  <div class="experience-step">
                    <h2 class="experience-step-title">STAP 3</h2>
                    <p class="experience-step-text">${properties.stap3}</p>
                  </div>
                  
                  <div class="experience-step">
                    <h2 class="experience-step-title">STAP 4</h2>
                    <p class="experience-step-text">${properties.stap4}</p>
                  </div>
                </div>
                
                <div class="ar-mural-buttons">
                  <button class="more-info-button button-base">Terug</button>
                  <button class="impressie-button button-base" onclick="window.open('${properties.link_ar}', '_blank')">Start AR</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    };
  } else {
    // Regular location popup
    return {
      styles,
      html: `
        <div class="popup-wrapper">
          <button class="close-button" aria-label="Close popup"></button>
          <div class="popup-side popup-front">
            <svg class="popup-border-overlay" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M0 227.13V240.82C0 246.99 5 252 11.18 252H19.2C25.38 252 30.38 246.99 30.38 240.82C30.38 246.99 35.4 252 41.56 252H49.6C55.75 252 60.75 247.01 60.76 240.85C60.79 247.01 65.79 252 71.94 252H79.98C86.15 252 91.16 246.99 91.16 240.82C91.16 246.99 96.16 252 102.34 252H110.36C116.53 252 121.53 247.01 121.54 240.84C121.55 247.01 126.55 252 132.72 252H140.74C146.35 252 150.99 247.87 151.79 242.48C152.6 247.87 157.24 252 162.85 252H170.87C177.04 252 182.04 247 182.05 240.84C182.06 247 187.06 252 193.23 252H201.25C207.03 252 211.78 247.62 212.36 242C212.95 247.62 217.7 252 223.48 252H231.5C237.68 252 242.68 246.99 242.68 240.82C242.68 246.99 247.69 252 253.86 252H261.89C268.05 252 273.05 247.01 273.06 240.85C273.08 247.01 278.08 252 284.24 252H292.27C298.44 252 303.45 246.99 303.45 240.82C303.45 246.99 308.46 252 314.63 252H322.66C328.82 252 333.82 247.01 333.83 240.84C333.85 247.01 338.85 252 345.01 252H353.04C359.21 252 364.22 246.99 364.22 240.82V227.13C364.22 220.95 359.21 215.95 353.04 215.95C359.21 215.95 364.22 210.94 364.22 204.77V191.07C364.22 184.9 359.21 179.89 353.04 179.89C359.21 179.89 364.22 174.89 364.22 168.71V155.02C364.22 149.52 360.25 144.96 355.02 144.03C360.25 143.09 364.22 138.53 364.22 133.03V119.34C364.22 113.17 359.22 108.17 353.06 108.16C359.22 108.16 364.22 103.15 364.22 96.98V83.29C364.22 77.11 359.21 72.11 353.04 72.11C359.21 72.11 364.22 67.1 364.22 60.93V47.23C364.22 41.06 359.21 36.05 353.04 36.05C359.21 36.05 364.22 31.05 364.22 24.87V11.18C364.22 5.01 359.21 0 353.04 0H345.01C338.85 0 333.85 4.99 333.83 11.16C333.82 4.99 328.82 0 322.66 0H314.63C308.46 0 303.45 5.01 303.45 11.18C303.45 5.01 298.44 0 292.27 0H284.24C278.08 0 273.08 4.99 273.06 11.16C273.05 4.99 268.05 0 261.89 0H253.86C247.69 0 242.68 5.01 242.68 11.18C242.68 5.01 237.68 0 231.5 0H223.48C217.7 0 212.95 4.38 212.36 10C211.78 4.38 207.03 0 201.25 0H193.23C187.06 0 182.06 5 182.05 11.16C182.04 5 177.04 0 170.87 0H162.85C157.24 0 152.6 4.13 151.79 9.52C150.99 4.13 146.35 0 140.74 0H132.72C126.55 0 121.55 4.99 121.54 11.16C121.53 4.99 116.53 0 110.36 0H102.34C96.16 0 91.16 5.01 91.16 11.18C91.16 5.01 86.15 0 79.98 0H71.94C65.79 0 60.79 4.99 60.76 11.16C60.75 4.99 55.75 0 49.6 0H41.56C35.4 0 30.38 5.01 30.38 11.18C30.38 5.01 25.38 0 19.2 0H11.18C5 0 0 5.01 0 11.18V24.87C0 31.05 5 36.05 11.18 36.05C5 36.05 0 41.06 0 47.23V60.93C0 67.1 5 72.11 11.18 72.11C5 72.11 0 77.11 0 83.29V96.98C0 103.15 4.99 108.15 11.16 108.16C4.99 108.17 0 113.17 0 119.34V133.03C0 138.53 3.97 143.09 9.19 144.03C3.97 144.96 0 149.52 0 155.02V168.71C0 174.89 5 179.89 11.18 179.89C5 179.89 0 184.9 0 191.07V204.77C0 210.94 5 215.95 11.18 215.95C5 215.95 0 220.95 0 227.13ZM333.83 24.89C333.85 31.06 338.85 36.05 345.01 36.05C338.85 36.05 333.85 41.05 333.83 47.21C333.82 41.05 328.82 36.05 322.66 36.05C328.82 36.05 333.82 31.06 333.83 24.89ZM333.83 60.95C333.85 67.11 338.85 72.11 345.01 72.11C338.85 72.11 333.85 77.1 333.83 83.27C333.82 77.1 328.82 72.11 322.66 72.11C328.82 72.11 333.82 67.11 333.83 60.95ZM333.83 119.32C333.82 113.16 328.83 108.17 322.68 108.16C328.83 108.16 333.82 103.16 333.83 97C333.85 103.16 338.83 108.15 344.99 108.16C338.83 108.17 333.85 113.16 333.83 119.32ZM343.03 144.03C337.81 144.96 333.84 149.51 333.83 155C333.82 149.51 329.86 144.96 324.64 144.03C329.86 143.09 333.82 138.54 333.83 133.05C333.83 138.54 337.81 143.09 343.03 144.03ZM333.83 168.73C333.85 174.9 338.85 179.89 345.01 179.89C338.85 179.89 333.85 184.89 333.83 191.05C333.82 184.89 328.82 179.89 322.66 179.89C328.82 179.89 333.82 174.9 333.83 168.73ZM333.83 204.79C333.85 210.95 338.85 215.95 345.01 215.95C338.85 215.95 333.85 220.94 333.83 227.11C333.82 220.94 328.82 215.95 322.66 215.95C328.82 215.95 333.82 210.95 333.83 204.79ZM303.45 24.87C303.45 31.05 308.46 36.05 314.63 36.05C308.46 36.05 303.45 41.06 303.45 47.23C303.45 41.06 298.44 36.05 292.27 36.05C298.44 36.05 303.45 31.05 303.45 24.87ZM303.45 60.93C303.45 67.1 308.46 72.11 314.63 72.11C308.46 72.11 303.45 77.11 303.45 83.29C303.45 77.11 298.44 72.11 292.27 72.11C298.44 72.11 303.45 67.1 303.45 60.93ZM303.45 119.34C303.45 113.17 298.45 108.17 292.29 108.16C298.45 108.16 303.45 103.15 303.45 96.98C303.45 103.15 308.45 108.15 314.61 108.16C308.45 108.17 303.45 113.17 303.45 119.34ZM312.64 144.03C307.42 144.96 303.45 149.52 303.45 155.02C303.45 149.52 299.48 144.96 294.25 144.03C299.48 143.09 303.45 138.53 303.45 133.03C303.45 138.53 307.42 143.09 312.64 144.03ZM303.45 168.71C303.45 174.89 308.46 179.89 314.63 179.89C308.46 179.89 303.45 184.9 303.45 191.07C303.45 184.9 298.44 179.89 292.27 179.89C298.44 179.89 303.45 174.89 303.45 168.71ZM303.45 204.77C303.45 210.94 308.46 215.95 314.63 215.95C308.46 215.95 303.45 220.95 303.45 227.13C303.45 220.95 298.44 215.95 292.27 215.95C298.44 215.95 303.45 210.94 303.45 204.77ZM273.06 24.9C273.08 31.06 278.08 36.05 284.24 36.05C278.08 36.05 273.08 41.05 273.06 47.21C273.05 41.05 268.05 36.05 261.89 36.05C268.05 36.05 273.05 31.06 273.06 24.9ZM273.06 60.95C273.08 67.11 278.08 72.11 284.24 72.11C278.08 72.11 273.08 77.1 273.06 83.26C273.05 77.1 268.05 72.11 261.89 72.11C268.05 72.11 273.05 67.11 273.06 60.95ZM273.06 119.31C273.05 113.16 268.06 108.17 261.91 108.16C268.06 108.16 273.05 103.16 273.06 97.01C273.08 103.16 278.07 108.15 284.22 108.16C278.07 108.17 273.08 113.16 273.06 119.31ZM282.26 144.03C277.04 144.96 273.08 149.51 273.06 154.99C273.05 149.51 269.09 144.96 263.87 144.03C269.09 143.09 273.05 138.54 273.06 133.06C273.08 138.54 277.04 143.09 282.26 144.03ZM273.06 168.74C273.08 174.9 278.08 179.89 284.24 179.89C278.08 179.89 273.08 184.89 273.06 191.05C273.05 184.89 268.05 179.89 261.89 179.89C268.05 179.89 273.05 174.9 273.06 168.74ZM273.06 204.79C273.08 210.95 278.08 215.95 284.24 215.95C278.08 215.95 273.08 220.94 273.06 227.1C273.05 220.94 268.05 215.95 261.89 215.95C268.05 215.95 273.05 210.95 273.06 204.79ZM242.68 24.87C242.68 31.05 247.69 36.05 253.86 36.05C247.69 36.05 242.68 41.06 242.68 47.23C242.68 41.06 237.68 36.05 231.5 36.05C237.68 36.05 242.68 31.05 242.68 24.87ZM242.68 60.93C242.68 67.1 247.69 72.11 253.86 72.11C247.69 72.11 242.68 77.11 242.68 83.29C242.68 77.11 237.68 72.11 231.5 72.11C237.68 72.11 242.68 67.1 242.68 60.93ZM242.68 119.34C242.68 113.17 237.69 108.17 231.52 108.16C237.69 108.16 242.68 103.15 242.68 96.98C242.68 103.15 247.68 108.15 253.84 108.16C247.68 108.17 242.68 113.17 242.68 119.34ZM251.87 144.03C246.65 144.96 242.68 149.52 242.68 155.02C242.68 149.52 238.71 144.96 233.49 144.03C238.71 143.09 242.68 138.53 242.68 133.03C242.68 138.53 246.65 143.09 251.87 144.03ZM242.68 168.71C242.68 174.89 247.69 179.89 253.86 179.89C247.69 179.89 242.68 184.9 242.68 191.07C242.68 184.9 237.68 179.89 231.5 179.89C237.68 179.89 242.68 174.89 242.68 168.71ZM242.68 204.77C242.68 210.94 247.69 215.95 253.86 215.95C247.69 215.95 242.68 220.95 242.68 227.13C242.68 220.95 237.68 215.95 231.5 215.95C237.68 215.95 242.68 210.94 242.68 204.77ZM212.36 26.05C212.95 31.68 217.7 36.05 223.48 36.05C217.7 36.05 212.95 40.43 212.36 46.05C211.78 40.43 207.03 36.05 201.25 36.05C207.03 36.05 211.78 31.68 212.36 26.05ZM212.36 62.11C212.95 67.73 217.7 72.11 223.48 72.11C217.7 72.11 212.95 76.48 212.36 82.11C211.78 76.48 207.03 72.11 201.25 72.11C207.03 72.11 211.78 67.73 212.36 62.11ZM212.36 118.16C211.78 112.54 207.04 108.17 201.28 108.16C207.04 108.16 211.78 103.78 212.36 98.16C212.95 103.78 217.69 108.15 223.46 108.16C217.69 108.17 212.95 112.54 212.36 118.16ZM221.49 144.03C216.64 144.89 212.88 148.88 212.36 153.85C211.86 148.88 208.1 144.89 203.24 144.03C208.1 143.16 211.86 139.17 212.36 134.2C212.88 139.17 216.64 143.16 221.49 144.03ZM212.36 169.89C212.95 175.52 217.7 179.89 223.48 179.89C217.7 179.89 212.95 184.27 212.36 189.89C211.78 184.27 207.03 179.89 201.25 179.89C207.03 179.89 211.78 175.52 212.36 169.89ZM212.36 205.95C212.95 211.57 217.7 215.95 223.48 215.95C217.7 215.95 212.95 220.32 212.36 225.95C211.78 220.32 207.03 215.95 201.25 215.95C207.03 215.95 211.78 211.57 212.36 205.95ZM182.05 24.89C182.06 31.06 187.06 36.05 193.23 36.05C187.06 36.05 182.06 41.05 182.05 47.22C182.04 41.05 177.04 36.05 170.87 36.05C177.04 36.05 182.04 31.06 182.05 24.89ZM182.05 60.95C182.06 67.11 187.06 72.11 193.23 72.11C187.06 72.11 182.06 77.1 182.05 83.27C182.04 77.1 177.04 72.11 170.87 72.11C177.04 72.11 182.04 67.11 182.05 60.95ZM182.05 119.32C182.04 113.16 177.05 108.17 170.9 108.16C177.05 108.16 182.04 103.16 182.05 97C182.06 103.16 187.05 108.15 193.22 108.16C187.05 108.17 182.06 113.16 182.05 119.32ZM191.24 144.03C186.03 144.96 182.06 149.51 182.05 155C182.04 149.51 178.09 144.96 172.86 144.03C178.09 143.09 182.04 138.54 182.05 133.05C182.06 138.54 186.03 143.09 191.24 144.03ZM182.05 168.73C182.06 174.9 187.06 179.89 193.23 179.89C187.06 179.89 182.06 184.89 182.05 191.05C182.04 184.89 177.04 179.89 170.87 179.89C177.04 179.89 182.04 174.9 182.05 168.73ZM182.05 204.79C182.06 210.95 187.06 215.95 193.23 215.95C187.06 215.95 182.06 220.94 182.05 227.11C182.04 220.94 177.04 215.95 170.87 215.95C177.04 215.95 182.04 210.95 182.05 204.79ZM151.79 26.53C152.6 31.92 157.24 36.05 162.85 36.05C157.24 36.05 152.6 40.18 151.79 45.57C150.99 40.18 146.35 36.05 140.74 36.05C146.35 36.05 150.99 31.92 151.79 26.53ZM151.79 62.59C152.6 67.98 157.24 72.11 162.85 72.11C157.24 72.11 152.6 76.24 151.79 81.63C150.99 76.24 146.35 72.11 140.74 72.11C146.35 72.11 150.99 67.98 151.79 62.59ZM151.79 117.68C151 112.3 146.36 108.17 140.76 108.16C146.36 108.16 151 104.02 151.79 98.64C152.6 104.02 157.23 108.15 162.84 108.16C157.23 108.17 152.6 112.3 151.79 117.68ZM160.86 144.03C156.18 144.86 152.5 148.62 151.79 153.35C151.1 148.62 147.41 144.86 142.73 144.03C147.41 143.19 151.1 139.43 151.79 134.7C152.5 139.43 156.18 143.19 160.86 144.03ZM151.79 170.37C152.6 175.76 157.24 179.89 162.85 179.89C157.24 179.89 152.6 184.02 151.79 189.41C150.99 184.02 146.35 179.89 140.74 179.89C146.35 179.89 150.99 175.76 151.79 170.37ZM151.79 206.43C152.6 211.82 157.24 215.95 162.85 215.95C157.24 215.95 152.6 220.08 151.79 225.47C150.99 220.08 146.35 215.95 140.74 215.95C146.35 215.95 150.99 211.82 151.79 206.43ZM121.54 24.89C121.55 31.06 126.55 36.05 132.72 36.05C126.55 36.05 121.55 41.05 121.54 47.21C121.53 41.05 116.53 36.05 110.36 36.05C116.53 36.05 121.53 31.06 121.54 24.89ZM121.54 60.95C121.55 67.11 126.55 72.11 132.72 72.11C126.55 72.11 121.55 77.1 121.54 83.27C121.53 77.1 116.53 72.11 110.36 72.11C116.53 72.11 121.53 67.11 121.54 60.95ZM121.54 119.32C121.53 113.16 116.54 108.17 110.38 108.16C116.54 108.16 121.53 103.16 121.54 97C121.55 103.16 126.54 108.15 132.69 108.16C126.54 108.17 121.55 113.16 121.54 119.32ZM130.73 144.03C125.51 144.96 121.54 149.51 121.54 155C121.53 149.51 117.56 144.96 112.35 144.03C117.56 143.09 121.53 138.54 121.54 133.05C121.54 138.54 125.51 143.09 130.73 144.03ZM121.54 168.73C121.55 174.9 126.55 179.89 132.72 179.89C126.55 179.89 121.55 184.89 121.54 191.05C121.53 184.89 116.53 179.89 110.36 179.89C116.53 179.89 121.53 174.9 121.54 168.73ZM121.54 204.79C121.55 210.95 126.55 215.95 132.72 215.95C126.55 215.95 121.55 220.94 121.54 227.11C121.53 220.94 116.53 215.95 110.36 215.95C116.53 215.95 121.53 210.95 121.54 204.79ZM91.16 24.87C91.16 31.05 96.16 36.05 102.34 36.05C96.16 36.05 91.16 41.06 91.16 47.23C91.16 41.06 86.15 36.05 79.98 36.05C86.15 36.05 91.16 31.05 91.16 24.87ZM91.16 60.93C91.16 67.1 96.16 72.11 102.34 72.11C96.16 72.11 91.16 77.11 91.16 83.29C91.16 77.11 86.15 72.11 79.98 72.11C86.15 72.11 91.16 67.1 91.16 60.93ZM91.16 119.34C91.16 113.17 86.16 108.17 79.99 108.16C86.16 108.16 91.16 103.15 91.16 96.98C91.16 103.15 96.16 108.15 102.31 108.16C96.16 108.17 91.16 113.17 91.16 119.34ZM100.35 144.03C95.12 144.96 91.16 149.52 91.16 155.02C91.16 149.52 87.18 144.96 81.95 144.03C87.18 143.09 91.16 138.53 91.16 133.03C91.16 138.53 95.12 143.09 100.35 144.03ZM91.16 168.71C91.16 174.89 96.16 179.89 102.34 179.89C96.16 179.89 91.16 184.9 91.16 191.07C91.16 184.9 86.15 179.89 79.98 179.89C86.15 179.89 91.16 174.89 91.16 168.71ZM91.16 204.77C91.16 210.94 96.16 215.95 102.34 215.95C96.16 215.95 91.16 220.95 91.16 227.13C91.16 220.95 86.15 215.95 79.98 215.95C86.15 215.95 91.16 210.94 91.16 204.77ZM60.76 24.9C60.79 31.06 65.79 36.05 71.94 36.05C65.79 36.05 60.79 41.05 60.76 47.21C60.75 41.05 55.75 36.05 49.6 36.05C55.75 36.05 60.75 31.06 60.76 24.9ZM60.76 60.95C60.79 67.11 65.79 72.11 71.94 72.11C65.79 72.11 60.79 77.1 60.76 83.26C60.75 77.1 55.75 72.11 49.6 72.11C55.75 72.11 60.75 67.11 60.76 60.95ZM60.76 119.31C60.75 113.16 55.76 108.17 49.61 108.16C55.76 108.16 60.75 103.16 60.76 97.01C60.79 103.16 65.78 108.15 71.92 108.16C65.78 108.17 60.79 113.16 60.76 119.31ZM69.97 144.03C64.74 144.96 60.79 149.51 60.76 154.99C60.75 149.51 56.79 144.96 51.57 144.03C56.79 143.09 60.75 138.54 60.76 133.06C60.79 138.54 64.74 143.09 69.97 144.03ZM60.76 168.74C60.79 174.9 65.79 179.89 71.94 179.89C65.79 179.89 60.79 184.89 60.76 191.05C60.75 184.89 55.75 179.89 49.6 179.89C55.75 179.89 60.75 174.9 60.76 168.74ZM60.76 204.79C60.79 210.95 65.79 215.95 71.94 215.95C65.79 215.95 60.79 220.94 60.76 227.1C60.75 220.94 55.75 215.95 49.6 215.95C55.75 215.95 60.75 210.95 60.76 204.79ZM30.38 24.87C30.38 31.05 35.4 36.05 41.56 36.05C35.4 36.05 30.38 41.06 30.38 47.23C30.38 41.06 25.38 36.05 19.2 36.05C25.38 36.05 30.38 31.05 30.38 24.87ZM30.38 60.93C30.38 67.1 35.4 72.11 41.56 72.11C35.4 72.11 30.38 77.11 30.38 83.29C30.38 77.11 25.38 72.11 19.2 72.11C25.38 72.11 30.38 67.1 30.38 60.93ZM30.38 119.34C30.38 113.17 25.4 108.17 19.23 108.16C25.4 108.16 30.38 103.15 30.38 96.98C30.38 103.15 35.38 108.15 41.54 108.16C35.38 108.17 30.38 113.17 30.38 119.34ZM39.57 144.03C34.35 144.96 30.38 149.52 30.38 155.02C30.38 149.52 26.41 144.96 21.19 144.03C26.41 143.09 30.38 138.53 30.38 133.03C30.38 138.53 34.35 143.09 39.57 144.03ZM30.38 168.71C30.38 174.89 35.4 179.89 41.56 179.89C35.4 179.89 30.38 184.9 30.38 191.07C30.38 184.9 25.38 179.89 19.2 179.89C25.38 179.89 30.38 174.89 30.38 168.71ZM30.38 204.77C30.38 210.94 35.4 215.95 41.56 215.95C35.4 215.95 30.38 220.95 30.38 227.13C30.38 220.95 25.38 215.95 19.2 215.95C25.38 215.95 30.38 210.94 30.38 204.77Z" fill="url(#paint0_linear_3248_5)"/>
              <defs>
                <linearGradient id="paint0_linear_3248_5" x1="182.11" y1="0" x2="182.11" y2="252" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="${properties.color}" stop-opacity="0" />
                  <stop offset="0.3" stop-color="${properties.color}" stop-opacity="1" />
                </linearGradient>
              </defs>
            </svg>
            ${properties.image ? `<img src="${properties.image}" class="popup-background-image" alt="">` : ""}
            <div class="content-wrapper">
              <div class="popup-title">${properties.name}</div>
              <div class="popup-description">${properties.description}</div>
              ${properties.image ? '<button class="impressie-button button-base">Impressie</button>' : ""}
              <button class="more-info-button button-base">Meer info</button>
            </div>
          </div>
          
          <div class="popup-side popup-back">
            <div class="content-wrapper">
              <div class="popup-title details">${properties.name || 'Naam error'}</div>
              <div class="info-content">
                <dl class="contact-container">
                  <div class="info-row">
                    <dt>ADRESS</dt>
                    <dd>
                      ${properties.locatie ? `
                        <a 
                          href="https://www.google.com/maps/search/${encodeURIComponent(properties.locatie)}" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          class="contact-link"
                          aria-label="Open locatie in Google Maps"
                        >
                          ${properties.locatie}
                        </a>
                      ` : `<span class="error-message">Adres error</span>`}
                    </dd>
                  </div>
                  <div class="info-row">
                    <dt>CONTACT</dt>
                    <dd>
                      ${properties.telefoonummer ? `
                        <a 
                          href="tel:${properties.telefoonummer}" 
                          class="contact-link"
                          aria-label="Bel naar ${properties.telefoonummer}"
                        >
                          ${properties.telefoonummer}
                        </a>
                      ` : `<span class="error-message">Telefoonnummer error</span>`}
                    </dd>
                  </div>
                  <div class="info-row">
                    <dt>WEBSITE</dt>
                    <dd>
                      ${properties.website ? `
                        <a 
                          href="${properties.website}" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          class="contact-link"
                          aria-label="Bezoek ${properties.name} website"
                        >
                          ${properties.name.replace(/^https?:\/\//i, '').toUpperCase()}
                        </a>
                      ` : `<span class="error-message">Website error</span>`}
                    </dd>
                  </div>
                </dl>
                
                <div class="opening-hours">
                  <h2>OPENINGSTIJDEN</h2>
                  <table>
                    <tbody>
                      <tr>
                        <th>MAANDAG</th>
                        <td>${properties.maandag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>DINSDAG</th>
                        <td>${properties.dinsdag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>WOENSDAG</th>
                        <td>${properties.woensdag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>DONDERDAG</th>
                        <td>${properties.donderdag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>VRIJDAG</th>
                        <td>${properties.vrijdag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>ZATERDAG</th>
                        <td>${properties.zaterdag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                      <tr>
                        <th>ZONDAG</th>
                        <td>${properties.zondag || '<span class="error-message">Niet beschikbaar</span>'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <button class="more-info-button button-base">Terug</button>
            </div>
          </div>
        </div>
      `
    };
  }
}

/**
 * Set up popup interactions
 */
function setupPopupInteractions(popup, properties, coordinates) {
  const popupElement = popup.getElement();
  const popupContent = popupElement.querySelector(".mapboxgl-popup-content");
  const popupWrapper = popupElement.querySelector(".popup-wrapper");
  const frontContent = popupElement.querySelector(".popup-front .content-wrapper");
  const backContent = popupElement.querySelector(".popup-back .content-wrapper");
  const description = popupElement.querySelector(".popup-description");
  const gradient = popupElement.querySelector("#paint0_linear_3248_5");
  

  
  /**
   * Animate gradient stops
   */
  function animateGradient(newY1, newY2, gradient) {
    const startY1 = parseFloat(gradient.y1.baseVal.value);
    const startY2 = parseFloat(gradient.y2.baseVal.value);
    const startTime = Date.now();
    
    function step() {
      const progress = Math.min((Date.now() - startTime) / 800, 1);
      gradient.y1.baseVal.value = startY1 + (newY1 - startY1) * progress;
      gradient.y2.baseVal.value = startY2 + (newY2 - startY2) * progress;
      
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }
    
    requestAnimationFrame(step);
  }
  
  /**
   * Adjust popup height to content
   */
  function adjustPopupHeight() {
    const contentHeight = Math.max(frontContent.offsetHeight, backContent.offsetHeight);
    popupWrapper.style.height = `${contentHeight}px`;
    
    popupElement.querySelectorAll(".popup-side").forEach(side => {
      side.style.height = `${contentHeight}px`;
    });
  }
  
  // Set up hover effect on gradient
  popupWrapper.addEventListener("mouseenter", () => {
    animateGradient(30, 282, gradient);
  });
  
  popupWrapper.addEventListener("mouseleave", () => {
    animateGradient(0, 252, gradient);
  });
  
  // Adjust height
  setTimeout(adjustPopupHeight, 10);
  
  // Animate popup appearance
  popupContent.style.opacity = "0";
  popupContent.style.transform = "rotate(8deg) translateY(40px) scale(0.4)";
  
  requestAnimationFrame(() => {
    popupContent.style.transition = "all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)";
    popupContent.style.opacity = "1";
    popupContent.style.transform = "rotate(0deg) translateY(0) scale(1)";
  });
  
  // Handle scrollable description
  if (description) {
    // Wheel event
    description.addEventListener("wheel", event => {
      event.stopPropagation();
      event.preventDefault();
      description.scrollTop += event.deltaY;
    }, { passive: false });
    
    // Mouse interactions
    description.addEventListener("mouseenter", () => {
      map.dragPan.disable();
      map.scrollZoom.disable();
    });
    
    description.addEventListener("mouseleave", () => {
      map.dragPan.enable();
      map.scrollZoom.enable();
    });
    
    // Mouse drag to scroll
    let isDragging = false;
    let startY, startScrollTop;
    
    description.addEventListener("mousedown", event => {
      isDragging = true;
      startY = event.pageY;
      startScrollTop = description.scrollTop;
      description.style.cursor = "grabbing";
      event.preventDefault();
      event.stopPropagation();
    });
    
    description.addEventListener("mousemove", event => {
      if (!isDragging) return;
      
      event.preventDefault();
      event.stopPropagation();
      
      const deltaY = event.pageY - startY;
      description.scrollTop = startScrollTop - deltaY;
    });
    
    document.addEventListener("mouseup", () => {
      isDragging = false;
      description.style.cursor = "grab";
    });
    
    description.addEventListener("mouseleave", () => {
      isDragging = false;
      description.style.cursor = "grab";
    });
    
    // Touch interactions
    let touchStartY = 0;
    let touchStartScrollTop = 0;
    
    description.addEventListener("touchstart", event => {
      touchStartY = event.touches[0].clientY;
      touchStartScrollTop = description.scrollTop;
      event.stopPropagation();
    });
    
    description.addEventListener("touchmove", event => {
      const deltaY = touchStartY - event.touches[0].clientY;
      description.scrollTop = touchStartScrollTop + deltaY;
      event.stopPropagation();
      event.preventDefault();
    }, { passive: false });
  }
  
  // Handle impressie button click
  if (properties.image && popupElement.querySelector(".impressie-button")) {
    popupElement.querySelector(".impressie-button").addEventListener("click", () => {
      // Image popup should only be shown from the main popup, not from AR popups
      if (!properties.link_ar) {
        popupContent.style.transition = "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
        popupContent.style.transform = "rotate(-5deg) translateY(40px) scale(0.6)";
        popupContent.style.opacity = "0";
        
        setTimeout(() => {
          const contentHeight = Math.max(frontContent.offsetHeight, backContent.offsetHeight);
          popup.remove();
          activePopup = null;
          showImagePopup(properties, coordinates, contentHeight);
        }, 400);
      }
    });
  }
  
  // Handle info button click (flip card)
  popupElement.querySelectorAll(".more-info-button").forEach(button => {
    button.addEventListener("click", () => {
      popupWrapper.classList.toggle("is-flipped");
    });
  });
  
  // Handle close button click
  popupElement.querySelectorAll(".close-button").forEach(button => {
    button.addEventListener("click", () => {
      popupContent.style.transition = "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
      popupContent.style.transform = "rotate(-5deg) translateY(40px) scale(0.6)";
      popupContent.style.opacity = "0";
      
      setTimeout(() => {
        popup.remove();
        activePopup = null;
      }, 400);
    });
  });
  
  // Update height on window resize
  window.addEventListener("resize", adjustPopupHeight);
}

/**
 * Show a fullscreen image popup
 */
function showImagePopup(properties, coordinates, contentHeight) {
  const isMobile = window.matchMedia("(max-width: 479px)").matches;
  
  const popup = new mapboxgl.Popup({
    offset: { 
      bottom: [0, -5], 
      top: [0, 0], 
      left: [0, 0], 
      right: [0, 0] 
    },
    className: "custom-popup",
    closeButton: false,
    maxWidth: "300px",
    closeOnClick: false,
    anchor: "bottom"
  });
  
  // Fly to image location
  map.flyTo({
    center: coordinates,
    offset: isMobile ? [0, 200] : [0, 250],
    duration: 1000,
    essential: true
  });
  
  // Create popup content
  const html = `
    <style>
      .popup-wrapper {
        height: ${contentHeight}px;
      }

      .popup-side {
        background-color: ${properties.color || "#6B46C1"};
        clip-path: polygon(calc(100% - 0px) 26.5px, calc(100% - 0px) calc(100% - 26.5px), calc(100% - 0px) calc(100% - 26.5px), calc(100% - 0.34671999999995px) calc(100% - 22.20048px), calc(100% - 1.3505599999999px) calc(100% - 18.12224px), calc(100% - 2.95704px) calc(100% - 14.31976px), calc(100% - 5.11168px) calc(100% - 10.84752px), calc(100% - 7.76px) calc(100% - 7.76px), calc(100% - 10.84752px) calc(100% - 5.11168px), calc(100% - 14.31976px) calc(100% - 2.9570399999999px), calc(100% - 18.12224px) calc(100% - 1.35056px), calc(100% - 22.20048px) calc(100% - 0.34672px), calc(100% - 26.5px) calc(100% - 0px), calc(50% - -32.6px) calc(100% - 0px), calc(50% - -32.6px) calc(100% - 0px), calc(50% - -31.57121px) calc(100% - 0.057139999999947px), calc(50% - -30.56648px) calc(100% - 0.2255199999999px), calc(50% - -29.59427px) calc(100% - 0.50057999999996px), calc(50% - -28.66304px) calc(100% - 0.87775999999991px), calc(50% - -27.78125px) calc(100% - 1.3525px), calc(50% - -26.95736px) calc(100% - 1.92024px), calc(50% - -26.19983px) calc(100% - 2.57642px), calc(50% - -25.51712px) calc(100% - 3.31648px), calc(50% - -24.91769px) calc(100% - 4.13586px), calc(50% - -24.41px) calc(100% - 5.03px), calc(50% - -24.41px) calc(100% - 5.03px), calc(50% - -22.95654px) calc(100% - 7.6045699999999px), calc(50% - -21.23752px) calc(100% - 9.9929599999998px), calc(50% - -19.27298px) calc(100% - 12.17519px), calc(50% - -17.08296px) calc(100% - 14.13128px), calc(50% - -14.6875px) calc(100% - 15.84125px), calc(50% - -12.10664px) calc(100% - 17.28512px), calc(50% - -9.36042px) calc(100% - 18.44291px), calc(50% - -6.46888px) calc(100% - 19.29464px), calc(50% - -3.45206px) calc(100% - 19.82033px), calc(50% - -0.32999999999998px) calc(100% - 20px), calc(50% - -0.32999999999998px) calc(100% - 20px), calc(50% - 2.79179px) calc(100% - 19.82033px), calc(50% - 5.8079199999999px) calc(100% - 19.29464px), calc(50% - 8.69853px) calc(100% - 18.44291px), calc(50% - 11.44376px) calc(100% - 17.28512px), calc(50% - 14.02375px) calc(100% - 15.84125px), calc(50% - 16.41864px) calc(100% - 14.13128px), calc(50% - 18.60857px) calc(100% - 12.17519px), calc(50% - 20.57368px) calc(100% - 9.9929599999999px), calc(50% - 22.29411px) calc(100% - 7.60457px), calc(50% - 23.75px) calc(100% - 5.03px), calc(50% - 23.75px) calc(100% - 5.03px), calc(50% - 24.25769px) calc(100% - 4.1358599999999px), calc(50% - 24.85712px) calc(100% - 3.3164799999998px), calc(50% - 25.53983px) calc(100% - 2.57642px), calc(50% - 26.29736px) calc(100% - 1.92024px), calc(50% - 27.12125px) calc(100% - 1.3525px), calc(50% - 28.00304px) calc(100% - 0.87775999999997px), calc(50% - 28.93427px) calc(100% - 0.50057999999996px), calc(50% - 29.90648px) calc(100% - 0.22552000000002px), calc(50% - 30.91121px) calc(100% - 0.057140000000004px), calc(50% - 31.94px) calc(100% - 0px), 26.5px calc(100% - 0px), 26.5px calc(100% - 0px), 22.20048px calc(100% - 0.34671999999989px), 18.12224px calc(100% - 1.3505599999999px), 14.31976px calc(100% - 2.95704px), 10.84752px calc(100% - 5.1116799999999px), 7.76px calc(100% - 7.76px), 5.11168px calc(100% - 10.84752px), 2.95704px calc(100% - 14.31976px), 1.35056px calc(100% - 18.12224px), 0.34672px calc(100% - 22.20048px), 4.3855735949631E-31px calc(100% - 26.5px), 0px 26.5px, 0px 26.5px, 0.34672px 22.20048px, 1.35056px 18.12224px, 2.95704px 14.31976px, 5.11168px 10.84752px, 7.76px 7.76px, 10.84752px 5.11168px, 14.31976px 2.95704px, 18.12224px 1.35056px, 22.20048px 0.34672px, 26.5px 4.3855735949631E-31px, calc(50% - 26.74px) 0px, calc(50% - 26.74px) 0px, calc(50% - 25.31263px) 0.07137px, calc(50% - 23.91544px) 0.28176px, calc(50% - 22.55581px) 0.62559px, calc(50% - 21.24112px) 1.09728px, calc(50% - 19.97875px) 1.69125px, calc(50% - 18.77608px) 2.40192px, calc(50% - 17.64049px) 3.22371px, calc(50% - 16.57936px) 4.15104px, calc(50% - 15.60007px) 5.17833px, calc(50% - 14.71px) 6.3px, calc(50% - 14.71px) 6.3px, calc(50% - 13.6371px) 7.64798px, calc(50% - 12.446px) 8.89024px, calc(50% - 11.1451px) 10.01826px, calc(50% - 9.7428px) 11.02352px, calc(50% - 8.2475px) 11.8975px, calc(50% - 6.6676px) 12.63168px, calc(50% - 5.0115px) 13.21754px, calc(50% - 3.2876px) 13.64656px, calc(50% - 1.5043px) 13.91022px, calc(50% - -0.32999999999996px) 14px, calc(50% - -0.32999999999998px) 14px, calc(50% - -2.16431px) 13.9105px, calc(50% - -3.94768px) 13.6476px, calc(50% - -5.67177px) 13.2197px, calc(50% - -7.32824px) 12.6352px, calc(50% - -8.90875px) 11.9025px, calc(50% - -10.40496px) 11.03px, calc(50% - -11.80853px) 10.0261px, calc(50% - -13.11112px) 8.8992px, calc(50% - -14.30439px) 7.6577px, calc(50% - -15.38px) 6.31px, calc(50% - -15.38px) 6.31px, calc(50% - -16.27279px) 5.18562px, calc(50% - -17.25432px) 4.15616px, calc(50% - -18.31733px) 3.22714px, calc(50% - -19.45456px) 2.40408px, calc(50% - -20.65875px) 1.6925px, calc(50% - -21.92264px) 1.09792px, calc(50% - -23.23897px) 0.62586px, calc(50% - -24.60048px) 0.28184px, calc(50% - -25.99991px) 0.07138px, calc(50% - -27.43px) 8.9116630386686E-32px, calc(100% - 26.5px) 0px, calc(100% - 26.5px) 0px, calc(100% - 22.20048px) 0.34672px, calc(100% - 18.12224px) 1.35056px, calc(100% - 14.31976px) 2.95704px, calc(100% - 10.84752px) 5.11168px, calc(100% - 7.76px) 7.76px, calc(100% - 5.11168px) 10.84752px, calc(100% - 2.9570399999999px) 14.31976px, calc(100% - 1.35056px) 18.12224px, calc(100% - 0.34671999999995px) 22.20048px, calc(100% - 5.6843418860808E-14px) 26.5px);
      }

      .close-button {
        background: ${properties.color || "#6B46C1"};
      }
    </style>
    <div class="popup-wrapper">
      <button class="close-button" aria-label="Close popup"></button>
      <div class="popup-side">
        <div class="image-container">
          <img src="${properties.image}" alt="${properties.name}" class="full-image">
          <div class="button-container">
            <button class="back-button">Terug</button>
          </div>
          <div class="location-name">${properties.name}</div>
        </div>
      </div>
    </div>
  `;
  
  // Add popup to map
  popup.setLngLat(coordinates).setHTML(html).addTo(map);
  activePopup = popup;
  
  // Get DOM elements
  const popupElement = popup.getElement();
  const popupContent = popupElement.querySelector(".mapboxgl-popup-content");
  const closeButton = popupElement.querySelector(".close-button");
  const backButton = popupElement.querySelector(".back-button");
  
  // Animate popup appearance
  popupContent.style.opacity = "0";
  popupContent.style.transform = "rotate(8deg) translateY(40px) scale(0.4)";
  
  requestAnimationFrame(() => {
    popupContent.style.transition = "all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)";
    popupContent.style.opacity = "1";
    popupContent.style.transform = "rotate(0deg) translateY(0) scale(1)";
  });
  
  // Find gradient for hover effect if it exists
  const svgElement = popupElement.querySelector("svg");
  if (svgElement) {
    const gradient = svgElement.querySelector("linearGradient");
    if (gradient) {
      const popupWrapper = popupElement.querySelector(".popup-wrapper");
      popupWrapper.addEventListener("mouseenter", () => {
        animateGradient(30, 282, gradient);
      });
      
      popupWrapper.addEventListener("mouseleave", () => {
        animateGradient(0, 252, gradient);
      });
    }
  }
  
  // Handle close button click
  closeButton.addEventListener("click", () => {
    popupContent.style.transition = "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
    popupContent.style.transform = "rotate(-5deg) translateY(40px) scale(0.6)";
    popupContent.style.opacity = "0";
    
    setTimeout(() => {
      popup.remove();
      activePopup = null;
    }, 400);
  });
  
  // Handle back button click (return to main popup)
  backButton.addEventListener("click", () => {
    popupContent.style.transition = "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
    popupContent.style.transform = "rotate(-5deg) translateY(40px) scale(0.6)";
    popupContent.style.opacity = "0";
    
    setTimeout(() => {
      popup.remove();
      activePopup = null;
      
      // Create new main popup
      const mainPopup = new mapboxgl.Popup({
        offset: {
          bottom: [0, -5],
          top: [0, 0],
          left: [0, 0],
          right: [0, 0]
        },
        className: "custom-popup",
        closeButton: false,
        maxWidth: "300px",
        closeOnClick: false,
        anchor: "bottom"
      });
      
      const { styles, html } = createPopupContent(properties);
      mainPopup.setLngLat(coordinates).setHTML(`${styles}${html}`);
      mainPopup.addTo(map);
      activePopup = mainPopup;
      setupPopupInteractions(mainPopup, properties, coordinates);
      
      // Animate new popup appearance
      const newPopupContent = mainPopup.getElement().querySelector(".mapboxgl-popup-content");
      newPopupContent.style.opacity = "0";
      newPopupContent.style.transform = "rotate(8deg) translateY(40px) scale(0.4)";
      
      requestAnimationFrame(() => {
        newPopupContent.style.transition = "all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)";
        newPopupContent.style.opacity = "1";
        newPopupContent.style.transform = "rotate(0deg) translateY(0) scale(1)";
      });
    }, 400);
  });
}

/**
 * Close sidebar items
 */
function closeItem() {
  $(".locations-map_item").removeClass("is--show");
}

/**
 * Close sidebar items if visible
 */
function closeItemIfVisible() {
  if ($(".locations-map_item").hasClass("is--show")) {
    closeItem();
  }
}
// Handle marker click
map.on("click", "location-markers", async (event) => {
  const coordinates = event.features[0].geometry.coordinates.slice();
  const properties = event.features[0].properties;
  const isFlipped = false;
  const isAR = properties.type === "ar"; // Check of dit een AR marker is
  
  // Calculate offset based on screen size
  const offset = window.matchMedia("(max-width: 479px)").matches ? [0, 200] : [0, 250];
  
  // Fly to marker
  map.flyTo({ 
    center: coordinates, 
    offset, 
    duration: 1500, 
    essential: true 
  });
  
  // Handle existing sidebar items
  const visibleItem = $(".locations-map_item.is--show");
  if (visibleItem.length) {
    visibleItem.css({ 
      opacity: "0", 
      transform: "translateY(40px) scale(0.6)" 
    });
  }
  
  // Handle existing popup
  if (activePopup) {
    const popupContent = activePopup.getElement().querySelector(".mapboxgl-popup-content");
    popupContent.style.transition = "all 400ms cubic-bezier(0.68, -0.55, 0.265, 1.55)";
    popupContent.style.transform = "rotate(-5deg) translateY(20px) scale(0.8)";
    popupContent.style.opacity = "0";
  }
  
  // Wait for animations to complete
  await new Promise(resolve => setTimeout(resolve, 400));
  
  // Remove existing popup
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  
  // Alleen de sidebar tonen voor niet-AR markers
  if (!isAR) {
    // Reset all sidebar items
    $(".locations-map_item")
      .removeClass("is--show")
      .css({
        display: "none",
        transform: "translateY(40px) scale(0.6)",
        opacity: "0"
      });
      
    // Show sidebar
    $(".locations-map_wrapper").addClass("is--show");
      
    // Show current sidebar item
    const currentItem = $(".locations-map_item").eq(properties.arrayID);
    currentItem.css({
      display: "block",
      opacity: "0",
      transform: "translateY(40px) scale(0.6)"
    });
    
    // Force reflow
    currentItem[0].offsetHeight;
    
    // Animate sidebar item appearance
    requestAnimationFrame(() => {
      currentItem.css({
        transition: "all 400ms cubic-bezier(0.68, -0.55, 0.265, 1.55)",
        opacity: "1",
        transform: "translateY(0) scale(1)"
      }).addClass("is--show");
    });
  } else {
    // Voor AR markers, verberg de sidebar als deze zichtbaar is
    $(".locations-map_wrapper").removeClass("is--show");
    $(".locations-map_item").removeClass("is--show");
  }
  
  // Create new popup
  const popup = new mapboxgl.Popup({
    offset: { 
      bottom: [0, -5], 
      top: [0, 0], 
      left: [0, 0], 
      right: [0, 0] 
    },
    className: "custom-popup",
    closeButton: false,
    maxWidth: "300px",
    closeOnClick: false,
    anchor: "bottom"
  });
  
  // Update geolocation manager state
  if (window.geolocationManager) {
    window.geolocationManager.isPopupOpen = true;
  }
  
  // Create and add popup content
  const { styles, html } = createPopupContent(properties);
  popup.setLngLat(coordinates).setHTML(`${styles}${html}`).addTo(map);
  activePopup = popup;
  
  // Add popup close handler
  popup.on("close", () => {
    if (window.geolocationManager) {
      window.geolocationManager.isPopupOpen = false;
    }
  });
  
  // Setup popup interactions
  setupPopupInteractions(popup, properties, coordinates);
});

//! ============= MAP INTERACTION HANDLERS =============

// Map load event
map.on("load", () => {
  loadIcons();
  addCustomMarkers();
  setupLocationFilters();
  
  // Initial animation on load
  setTimeout(() => {
    const finalZoom = window.matchMedia("(max-width: 479px)").matches ? 17 : 18;
    
    map.jumpTo({
      center: CONFIG.MAP.center,
      zoom: 15,
      pitch: 0,
      bearing: 0
    });
    
    map.flyTo({
      center: CONFIG.MAP.center,
      zoom: finalZoom,
      pitch: 55,
      bearing: -17.6,
      duration: 6000,
      essential: true,
      easing: t => t * (2 - t) // Ease out quad
    });
  }, 5000);
});

// Close sidebar button
$(".close-block").on("click", () => {
  closeItem();
});

// Hide popups and sidebar on map interactions
["dragstart", "zoomstart", "rotatestart", "pitchstart"].forEach(eventType => {
  map.on(eventType, () => {
    // Hide sidebar if visible
    const visibleItem = $(".locations-map_item.is--show");
    if (visibleItem.length) {
      visibleItem.css({
        opacity: "0",
        transform: "translateY(40px) scale(0.6)",
        transition: "all 400ms cubic-bezier(0.68, -0.55, 0.265, 1.55)"
      });
      
      setTimeout(() => {
        visibleItem.removeClass("is--show");
      }, 400);
    }
    
    // Hide popup if visible
    if (activePopup) {
      const popupContent = activePopup.getElement().querySelector(".mapboxgl-popup-content");
      popupContent.style.transition = "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
      popupContent.style.transform = "rotate(-5deg) translateY(40px) scale(0.6)";
      popupContent.style.opacity = "0";
      
      setTimeout(() => {
        activePopup.remove();
        activePopup = null;
      }, 400);
    }
  });
});

//! ============= ZOOM LIMITS AND RESET =============
// Reset to Heerlen when zoomed out too far
map.on('zoomend', () => {
  const currentZoom = map.getZoom();
  if (currentZoom < 14) {
    // Create interaction blocker overlay
    const overlay = document.createElement('div');
    overlay.id = 'interaction-blocker';
    document.body.appendChild(overlay);

    // Fly back to center
    map.flyTo({
      center: CONFIG.MAP.center,
      zoom: 17,
      pitch: 45,
      bearing: -17.6,
      speed: 0.8,
      curve: 1.5,
      essential: true
    });

    // Fade overlay
    gsap.to(overlay, {
      duration: 2,
      backgroundColor: "rgba(255,255,255,0)",
      onComplete: () => {
        showStaggeredPopup(overlay);
      }
    });
  }
});

/**
 * Show animated popup text
 */
function showStaggeredPopup(overlay) {
  const popupText = "heerlen doen";
  const popupHTML = buildStaggeredTextHTML(popupText);

  const zoomendPopup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false
  })
  .setLngLat(CONFIG.MAP.center)
  .setHTML(popupHTML)
  .addTo(map);

  // Create animation timeline
  const tl = gsap.timeline({
    onComplete: () => {
      zoomendPopup.remove();
      overlay.remove();
    }
  });

  // Animate in
  tl.from(".zoomend-popup .letter", {
    duration: 0.2,
    opacity: 0,
    y: 20,
    stagger: 0.05
  });

  // Pause
  tl.to(".zoomend-popup .letter", {
    duration: 0.2,
  }, "+=1");

  // Animate out
  tl.to(".zoomend-popup .letter", {
    duration: 0.2,
    opacity: 0,
    y: -20,
    stagger: 0.05
  }, "+=1");
}

/**
 * Create HTML for animated text
 */
function buildStaggeredTextHTML(text) {
  // Split into individual characters
  const letters = text.split("");
  
  // Wrap each character in a span
  const letterSpans = letters.map(char => {
    if (char === " ") char = "&nbsp;";
    return `<span class="letter">${char}</span>`;
  }).join("");

  // Wrap in container
  return `<div class="zoomend-popup">${letterSpans}</div>`;
}

//! ============= THREEJS LAYER =============
// 3D model configurations
const modelConfigs = [
  {
    id: 'schunck',
    origin: [50.88778235149691, 5.979389928151281], // [lat, lng]
    altitude: 0,
    rotate: [Math.PI / 2, 0.45, 0],
    url: 'https://cdn.jsdelivr.net/gh/Artwalters/3dmodels_heerlen@main/schunckv5.glb',
    scale: 1.3
  },
  {
    id: 'theater',
    origin: [50.886541206107225, 5.972454838314243],
    altitude: 0,
    rotate: [Math.PI / 2, 2.05, 0],
    url: 'https://cdn.jsdelivr.net/gh/Artwalters/3dmodels_heerlen@main/theaterheerlenv4.glb',
    scale: 0.6
  }
];

// Image plane configuration
const imagePlaneConfig = {
  id: 'image1',
  origin: [50.88801513786042, 5.980644311376565],
  altitude: 6.5,
  rotate: [Math.PI / 2, 0.35, 0],
  imageUrl: 'https://daks2k3a4ib2z.cloudfront.net/671769e099775386585f574d/67adf2bff5be8a200ec2fa55_osgameos_mural-p-130x130q80.png',
  width: 13,
  height: 13
};

/**
 * Create image plane for THREE.js
 */
function createImagePlane(config) {
  // Convert coordinates
  const mercatorCoord = mapboxgl.MercatorCoordinate.fromLngLat(
    [config.origin[1], config.origin[0]],
    config.altitude
  );

  // Calculate scale
  const meterScale = mercatorCoord.meterInMercatorCoordinateUnits();
  const geoWidth = config.width * meterScale;
  const geoHeight = config.height * meterScale;

  return new Promise((resolve, reject) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      config.imageUrl,
      (texture) => {
        // Create material
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide
        });
        
        // Create geometry
        const geometry = new THREE.PlaneGeometry(geoWidth, geoHeight);
        const plane = new THREE.Mesh(geometry, material);

        // Store transform data
        plane.userData.transform = {
          translateX: mercatorCoord.x,
          translateY: mercatorCoord.y,
          translateZ: mercatorCoord.z,
          rotate: config.rotate,
          scale: 1
        };

        resolve(plane);
      },
      undefined,
      (error) => reject(error)
    );
  });
}

// Custom THREE.js layer
const customLayer = {
  id: '3d-models',
  type: 'custom',
  renderingMode: '3d',

  onAdd: function(map, gl) {
    this.map = map;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();

    // Setup lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.57);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.57);
    directionalLight.color.setHex(0xfcfcfc);
    
    // Position light
    const azimuth = 210 * (Math.PI / 180);
    const polar = 50 * (Math.PI / 180);
    directionalLight.position.set(
      Math.sin(azimuth) * Math.sin(polar),
      Math.cos(azimuth) * Math.sin(polar),
      Math.cos(polar)
    ).normalize();
    this.scene.add(directionalLight);

    // Setup renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true
    });
    this.renderer.autoClear = false;

    // Load 3D models
    const loader = new THREE.GLTFLoader();
    modelConfigs.forEach(config => {
      // Convert coordinates
      const mercCoord = mapboxgl.MercatorCoordinate.fromLngLat(
        [config.origin[1], config.origin[0]],
        config.altitude
      );

      // Load model
      loader.load(
        config.url,
        (gltf) => {
          const scene3D = gltf.scene;
          
          // Store transform data
          scene3D.userData.transform = {
            translateX: mercCoord.x,
            translateY: mercCoord.y,
            translateZ: mercCoord.z,
            rotate: config.rotate,
            scale: mercCoord.meterInMercatorCoordinateUnits() * config.scale
          };
          
          this.scene.add(scene3D);
        },
        undefined,
        (err) => console.error(err)
      );
    });

    // Load image plane
    createImagePlane(imagePlaneConfig)
      .then(plane => {
        this.scene.add(plane);
      })
      .catch(err => console.error('Error loading image plane:', err));
  },

  render: function(gl, matrix) {
    // Get Mapbox matrix
    const mapMatrix = new THREE.Matrix4().fromArray(matrix);

    // Apply transforms to each object
    this.scene.traverse(child => {
      if (child.userData.transform) {
        const t = child.userData.transform;
        
        // Create transform matrices
        const translation = new THREE.Matrix4().makeTranslation(
          t.translateX, t.translateY, t.translateZ
        );
        const scaling = new THREE.Matrix4().makeScale(t.scale, -t.scale, t.scale);
        const rotX = new THREE.Matrix4().makeRotationX(t.rotate[0]);
        const rotY = new THREE.Matrix4().makeRotationY(t.rotate[1]);
        const rotZ = new THREE.Matrix4().makeRotationZ(t.rotate[2]);

        // Combine transforms
        const modelMatrix = new THREE.Matrix4()
          .multiply(translation)
          .multiply(scaling)
          .multiply(rotX)
          .multiply(rotY)
          .multiply(rotZ);

        // Apply transformation
        child.matrix = new THREE.Matrix4().copy(mapMatrix).multiply(modelMatrix);
        child.matrixAutoUpdate = false;
      }
    });

    // Render scene
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
};

// Add THREE.js layer when map style is loaded
map.on('style.load', () => {
  map.addLayer(customLayer);
});