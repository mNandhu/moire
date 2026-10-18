### Moiré Frontend: A Visual & Interactive Design Guide

**Core Philosophy: "The Digital Collector's Gallery"**

The entire UI should feel like a modern, minimalist art gallery. The artwork is the hero; the interface is the clean, well-lit space that presents it. The design should be dark-themed by default to make the vibrant colors of AI art pop, but a light-theme toggle is a good addition. It's an application for *viewing and admiring* as much as it is for organizing.

**I. Overall Layout & Navigation**

The application uses a two-column layout: a fixed, icon-based sidebar on the left and a main content area on the right.

*   **Sidebar (Primary Navigation):**
    *   **Appearance:** A sleek, dark, and relatively narrow vertical bar. By default, it only shows icons to maximize screen real estate for the content. On hover, it could subtly expand to show text labels.
    *   **Links/Icons:**
        *   **Home/Dashboard Icon:** (e.g., a grid or compass icon) Navigates to the "All Images" gallery.
        *   **Library Icon:** (e.g., a stack of books or folders icon) Navigates to the "Libraries" management page.
        *   **Tags Icon:** (e.g., a single price tag or multiple tags icon) Navigates to the "Browse by Tag/Category" page.
        *   **Settings Icon (at the bottom):** (e.g., a gear icon) For future app settings.
    *   **Active State:** The icon for the currently active page should be highlighted (e.g., a brighter color, a vertical bar next to it).

*   **Main Content Area:**
    *   This is the dynamic area that changes based on the sidebar navigation. It will host all the different pages and galleries. It has a slight padding all around, creating a frame for the content.

**II. Key Page Designs**

**1. The "All Images" Page (Dashboard / Home)**

*   **Purpose:** The default landing page. The user's entire collection at a glance.
*   **Layout:**
    *   **Header:** A simple, clean header with the text "My Collection" or "All Images."
    *   **Action Bar (Sub-header):** A single row below the header containing the primary interaction tools for the gallery.
        *   **Search Bar:** The most prominent element. A wide, pill-shaped input field with a search icon. As the user types, it should suggest tags.
        *   **Filter/Sort Controls:** Dropdown menus (e.g., "Sort by: Date Added," "Filter by: Untagged") represented by clean icons to avoid clutter.
        *   **Selection Toggle:** A button like "Select" or an icon of a checkmark in a box. When toggled, it activates selection mode.
    *   **Image Gallery:** The main event. A fluid, responsive grid of `ImageThumbnail` components that fills the rest of the page. The grid should have a "masonry" feel if possible, where images of different aspect ratios fit together neatly. Infinite scroll should be used for lazy loading more images as the user scrolls down.

**2. The "Libraries" Page (Management View)**

*   **Route:** `/libraries`
*   **Purpose:** The "back office" for managing image sources.
*   **Layout:**
    *   **Header:** Title "Manage Libraries" and a prominent "+ Add Library" button. Clicking this button opens a clean, focused modal/dialog for entering the path and name.
    *   **Content:** A list or grid of "Library Cards."
        *   **Library Card Design:** Each card represents a library. It's a dark, rectangular card with subtle glowing edges on hover.
            *   **Top:** Library Name (e.g., "ComfyUI Outputs") in a bold, clean font.
            *   **Middle:** The full server path in a smaller, monospaced font.
            *   **Bottom:** Key stats displayed with icons: an image icon with the total image count, and a calendar icon with the "Last Scanned" date.
            *   **Actions:** On hover, action icons (Re-scan, Edit, Delete) appear, ensuring the default view is clean.

**3. The "Browse by Tag/Category" Page**

*   **Route:** `/tags`
*   **Purpose:** Discovering and exploring the collection through its core themes.
*   **Layout:**
    *   **Header:** Title "Browse by Tag." A search bar here allows filtering the tags/categories themselves.
    *   **Content:** A grid of large, impactful "Category Cards." This is designed to look like a high-level showcase.
        *   **Category Card Design:** These are larger than library cards and are very visual.
            *   **Background:** A full-bleed image serving as the thumbnail for that category/tag. This image is configurable by the user (as per the URD).
            *   **Overlay:** A dark, semi-transparent gradient at the bottom of the card ensures text is readable.
            *   **Text:** The name of the tag/category (e.g., "Cyberpunk Style," or a character name like "Astolfo") is displayed in large, elegant text on the gradient overlay. Below it, in smaller text, "X images."
            *   **Interaction:** Clicking anywhere on the card navigates the user to the specific page for that tag.

**III. Core Component Visuals**

*   **`ImageThumbnail` Component:**
    *   **Default State:** A simple, sharp image with rounded corners. No border. It should feel like the image is floating in the grid.
    *   **Hover State:** A subtle "glow" effect appears around the edges of the thumbnail (e.g., a soft, white `box-shadow`). A semi-transparent dark overlay appears on the image, containing a few key action icons (e.g., "View Details," "Add to Favorites"). The filename might appear on this overlay as well.
    *   **Selection State:** When selection mode is on, a subtle checkmark icon appears in a corner (e.g., top right). When the thumbnail is selected, the glow effect becomes a solid, thin, brightly colored border (e.g., blue or purple), and the checkmark icon becomes filled.

*   **`Individual Image View` (Modal or Full Page):**
    *   **Appearance:** When an image is clicked, it opens in a "lightbox" style modal that darkens the rest of an app, or navigates to a dedicated page (`/image/{image_id}`).
    *   **Layout:** A two-column layout.
        *   **Left Column (70% width):** The image itself, displayed as large as possible while fitting within the viewport.
        *   **Right Column (30% width):** The "Info Panel."
            *   **Top:** Filename, dimensions, file size.
            *   **Tags Section:** The most important part. A scrollable area displaying all current tags. Each tag is a clickable "pill" or "badge." There's an input field right here to "Add a new tag..." with autocompletion.
            *   **Actions:** Buttons like "Trigger AI Tagging," "Delete Image," "Download Original."
            *   **(Future) Metadata:** A collapsible section to show more technical data (e.g., creation date, EXIF data, embedded ComfyUI workflow JSON).

This visual guide should provide a strong direction for building a UI that is not only functional but also a pleasure to use for any AI art collector.