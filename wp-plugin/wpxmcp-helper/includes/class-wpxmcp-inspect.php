<?php
/**
 * Read-only introspection of registries, hooks, options and the database,
 * plus one guarded cleanup route for options and transients.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Read-only introspection of registries, hooks, options and the database.
 */
class WPXMCP_Inspect {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Inspect|null
	 */
	private static $instance = null;

	/**
	 * Registration call sites captured during a /registry request:
	 * kind => name => absolute file.
	 *
	 * @var array
	 */
	private static $registered_in = array(
		'post_type' => array(),
		'taxonomy'  => array(),
		'block'     => array(),
	);

	/**
	 * Cached path → owner map.
	 *
	 * @var array|null
	 */
	private static $roots = null;

	/**
	 * Hard cap on rows any list in a response carries.
	 */
	const MAX_LIMIT = 500;

	/**
	 * Site Health's default autoload warning threshold, in bytes.
	 */
	const AUTOLOAD_WARN_BYTES = 800000;

	/**
	 * Options a fresh install creates. Deleting them, or taking them out of
	 * autoload, is refused: WordPress re-reads them on every request.
	 *
	 * @var string[]
	 */
	private static $core_options = array(
		'siteurl', 'home', 'blogname', 'blogdescription', 'users_can_register', 'admin_email', 'start_of_week',
		'use_balancetags', 'use_smilies', 'require_name_email', 'comments_notify', 'posts_per_rss', 'rss_use_excerpt',
		'mailserver_url', 'mailserver_login', 'mailserver_pass', 'mailserver_port', 'default_category',
		'default_comment_status', 'default_ping_status', 'default_pingback_flag', 'posts_per_page', 'date_format',
		'time_format', 'links_updated_date_format', 'comment_moderation', 'moderation_notify', 'permalink_structure',
		'rewrite_rules', 'hack_file', 'blog_charset', 'moderation_keys', 'active_plugins', 'category_base', 'ping_sites',
		'comment_max_links', 'gmt_offset', 'default_email_category', 'recently_edited', 'template', 'stylesheet',
		'comment_registration', 'html_type', 'use_trackback', 'default_role', 'db_version', 'initial_db_version',
		'uploads_use_yearmonth_folders', 'upload_path', 'blog_public', 'default_link_category', 'show_on_front',
		'tag_base', 'show_avatars', 'avatar_rating', 'upload_url_path', 'thumbnail_size_w', 'thumbnail_size_h',
		'thumbnail_crop', 'medium_size_w', 'medium_size_h', 'avatar_default', 'large_size_w', 'large_size_h',
		'image_default_link_type', 'image_default_size', 'image_default_align', 'close_comments_for_old_posts',
		'close_comments_days_old', 'thread_comments', 'thread_comments_depth', 'page_comments', 'comments_per_page',
		'default_comments_page', 'comment_order', 'sticky_posts', 'widget_categories', 'widget_text', 'widget_rss',
		'uninstall_plugins', 'timezone_string', 'page_for_posts', 'page_on_front', 'default_post_format',
		'link_manager_enabled', 'finished_splitting_shared_terms', 'site_icon', 'medium_large_size_w',
		'medium_large_size_h', 'wp_page_for_privacy_policy', 'show_comments_cookies_opt_in', 'admin_email_lifespan',
		'disallowed_keys', 'comment_previously_approved', 'auto_plugin_theme_update_emails', 'auto_update_core_dev',
		'auto_update_core_minor', 'auto_update_core_major', 'wp_force_deactivated_plugins', 'wp_attachment_pages_enabled',
		'wp_notes_notify', 'cron', 'fresh_site', 'can_compress_scripts', 'db_upgraded', 'finished_updating_comment_type',
		'sidebars_widgets', 'widget_block', 'widget_search', 'widget_recent-posts', 'widget_recent-comments',
		'widget_archives', 'widget_meta', 'widget_pages', 'widget_calendar', 'widget_tag_cloud', 'widget_nav_menu',
		'widget_custom_html', 'widget_media_audio', 'widget_media_image', 'widget_media_gallery', 'widget_media_video',
		'nav_menu_options', 'current_theme', 'theme_switched', 'recovery_keys', 'recovery_mode_email_last_sent',
		'wplang', 'active_sitewide_plugins', 'recently_activated', 'category_children', 'user_count', 'site_logo',
		'https_detection_errors', 'auth_key', 'auth_salt', 'secure_auth_key', 'secure_auth_salt', 'logged_in_key',
		'logged_in_salt', 'nonce_key', 'nonce_salt', 'new_admin_email', 'adminhash', 'dismissed_update_core',
		'auto_core_update_notified', 'wp_calendar_block_has_published_posts', 'theme_switched_via_customizer',
		'customize_stashed_theme_mods', 'show_on_front', 'wp_user_roles',
	);

	/**
	 * Well-known option/meta/table prefixes whose owner slug does not match
	 * the prefix itself.
	 *
	 * @var array
	 */
	private static $known_prefixes = array(
		'wpseo'            => 'wordpress-seo',
		'yoast'            => 'wordpress-seo',
		'elementor'        => 'elementor',
		'rank_math'        => 'seo-by-rank-math',
		'aioseo'           => 'all-in-one-seo-pack',
		'woocommerce'      => 'woocommerce',
		'wc_'              => 'woocommerce',
		'actionscheduler'  => 'action-scheduler',
		'jetpack'          => 'jetpack',
		'akismet'          => 'akismet',
		'wpforms'          => 'wpforms-lite',
		'litespeed'        => 'litespeed-cache',
		'wp_rocket'        => 'wp-rocket',
		'rocket'           => 'wp-rocket',
		'w3tc'             => 'w3-total-cache',
		'wpcf7'            => 'contact-form-7',
		'acf'              => 'advanced-custom-fields',
		'fl_builder'       => 'beaver-builder-lite-version',
		'bricks'           => 'bricks',
		'breakdance'       => 'breakdance',
		'seedprod'         => 'coming-soon',
		'redirection'      => 'redirection',
		'wordfence'        => 'wordfence',
		'itsec'            => 'better-wp-security',
		'updraft'          => 'updraftplus',
		'wpxmcp'           => 'wpxmcp-helper',
		'monsterinsights'  => 'google-analytics-for-wordpress',
		'wpmdb'            => 'wp-migrate-db',
		'gf_'              => 'gravityforms',
		'rg_'              => 'gravityforms',
		'edd'              => 'easy-digital-downloads',
		'give'             => 'give',
		'tribe'            => 'the-events-calendar',
		'mailpoet'         => 'mailpoet',
		'smush'            => 'wp-smushit',
		'wp_mail_smtp'     => 'wp-mail-smtp',
		'duplicator'       => 'duplicator',
		'classic_editor'   => 'classic-editor',
	);

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Inspect
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );

		// Post types, taxonomies and blocks do not record where they were
		// registered. Only while serving a registry request, note the caller.
		if ( self::is_registry_request() ) {
			add_action( 'registered_post_type', array( __CLASS__, 'track_post_type' ), 0, 1 );
			add_action( 'registered_taxonomy', array( __CLASS__, 'track_taxonomy' ), 0, 1 );
			add_filter( 'block_type_metadata', array( __CLASS__, 'track_block_metadata' ), 0, 1 );
			add_filter( 'register_block_type_args', array( __CLASS__, 'track_block_args' ), 0, 2 );
		}
	}

	/**
	 * Whether this request targets the registry route.
	 *
	 * @return bool
	 */
	private static function is_registry_request() {
		$needle = 'wpxmcp/v1/registry';
		// phpcs:disable WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput
		if ( isset( $_GET['rest_route'] ) && is_string( $_GET['rest_route'] ) && false !== strpos( $_GET['rest_route'], $needle ) ) {
			return true;
		}
		return isset( $_SERVER['REQUEST_URI'] ) && false !== strpos( (string) $_SERVER['REQUEST_URI'], $needle );
		// phpcs:enable
	}

	/**
	 * Route table.
	 */
	public function register_routes() {
		$ns    = WPXMCP_NAMESPACE;
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( $ns, '/registry', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'registry' ),
			'permission_callback' => $admin,
			'args'                => array(
				'kind'   => array( 'type' => 'string', 'required' => true ),
				'filter' => array( 'type' => 'string', 'default' => '' ),
				'limit'  => array( 'type' => 'integer', 'default' => 100 ),
			),
		) );

		register_rest_route( $ns, '/options/report', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'options_report' ),
			'permission_callback' => $admin,
			'args'                => array(
				'limit' => array( 'type' => 'integer', 'default' => 25 ),
			),
		) );

		register_rest_route( $ns, '/options/cleanup', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'options_cleanup' ),
			'permission_callback' => $admin,
			'args'                => array(
				'action'  => array( 'type' => 'string', 'required' => true ),
				'names'   => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'default' => array() ),
				'dry_run' => array( 'type' => 'boolean', 'default' => true ),
			),
		) );

		register_rest_route( $ns, '/database', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'database' ),
			'permission_callback' => $admin,
		) );
	}

	/* ------------------------------------------------------------------ *
	 * Source attribution
	 * ------------------------------------------------------------------ */

	/**
	 * Registration trackers.
	 *
	 * @param string $name Post type.
	 */
	public static function track_post_type( $name ) {
		self::$registered_in['post_type'][ $name ] = self::caller_file();
	}

	/**
	 * @param string $name Taxonomy.
	 */
	public static function track_taxonomy( $name ) {
		self::$registered_in['taxonomy'][ $name ] = self::caller_file();
	}

	/**
	 * @param array $metadata block.json contents plus 'file'.
	 * @return array
	 */
	public static function track_block_metadata( $metadata ) {
		if ( is_array( $metadata ) && ! empty( $metadata['name'] ) && ! empty( $metadata['file'] ) ) {
			self::$registered_in['block'][ $metadata['name'] ] = wp_normalize_path( $metadata['file'] );
		}
		return $metadata;
	}

	/**
	 * @param array  $args Block args.
	 * @param string $name Block name.
	 * @return array
	 */
	public static function track_block_args( $args, $name ) {
		if ( ! isset( self::$registered_in['block'][ $name ] ) ) {
			self::$registered_in['block'][ $name ] = self::caller_file();
		}
		return $args;
	}

	/**
	 * The first file on the stack outside core's registration plumbing and
	 * this plugin — the code that asked for the registration.
	 *
	 * @return string
	 */
	private static function caller_file() {
		$includes = wp_normalize_path( ABSPATH . WPINC ) . '/';
		$self     = wp_normalize_path( __FILE__ );
		$first    = '';
		foreach ( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 40 ) as $frame ) { // phpcs:ignore
			if ( empty( $frame['file'] ) ) {
				continue;
			}
			$file = wp_normalize_path( $frame['file'] );
			if ( $file === $self ) {
				continue;
			}
			if ( '' === $first ) {
				$first = $file;
			}
			if ( 0 !== strpos( $file, $includes ) ) {
				return $file;
			}
		}
		// Only core frames: core registered it.
		return $first;
	}

	/**
	 * Directory roots mapped to owners, resolving symlinks so a plugin linked
	 * in from elsewhere is still attributed.
	 *
	 * @return array[] List of array( root, type, slug|null ).
	 */
	private static function roots() {
		if ( null !== self::$roots ) {
			return self::$roots;
		}
		$roots = array();
		$add   = static function ( $dir, $type, $slug ) use ( &$roots ) {
			$dir = wp_normalize_path( untrailingslashit( $dir ) );
			if ( '' === $dir ) {
				return;
			}
			$roots[] = array( $dir . '/', $type, $slug );
			$real    = realpath( $dir );
			if ( $real && wp_normalize_path( $real ) !== $dir ) {
				$roots[] = array( wp_normalize_path( $real ) . '/', $type, $slug );
			}
		};

		$scan = static function ( $base, $type ) use ( $add ) {
			$entries = is_dir( $base ) ? @scandir( $base ) : false; // phpcs:ignore
			foreach ( (array) $entries as $entry ) {
				if ( '.' === $entry || '..' === $entry || ! is_string( $entry ) ) {
					continue;
				}
				$path = $base . '/' . $entry;
				if ( is_dir( $path ) ) {
					$add( $path, $type, $entry );
				} elseif ( is_link( $path ) && realpath( $path ) ) {
					// A single-file plugin symlinked in.
					$add( dirname( realpath( $path ) ), $type, preg_replace( '/\.php$/', '', $entry ) );
				}
			}
		};

		$scan( WP_PLUGIN_DIR, 'plugin' );
		if ( defined( 'WPMU_PLUGIN_DIR' ) ) {
			$scan( WPMU_PLUGIN_DIR, 'mu-plugin' );
		}
		global $wp_theme_directories;
		foreach ( (array) $wp_theme_directories as $theme_root ) {
			$scan( $theme_root, 'theme' );
		}
		$add( ABSPATH . WPINC, 'core', null );
		$add( ABSPATH . 'wp-admin', 'core', null );

		// Longest root first, so a nested root wins.
		usort( $roots, static function ( $a, $b ) {
			return strlen( $b[0] ) - strlen( $a[0] );
		} );
		self::$roots = $roots;
		return $roots;
	}

	/**
	 * Map an absolute file path to what owns it.
	 *
	 * @param string $file Absolute path.
	 * @return array { type: core|plugin|mu-plugin|theme|dropin|unknown, slug }
	 */
	public static function source_of_file( $file ) {
		if ( ! is_string( $file ) || '' === $file ) {
			return array( 'type' => 'unknown', 'slug' => null );
		}
		$file = wp_normalize_path( $file );
		foreach ( self::roots() as $root ) {
			if ( 0 === strpos( $file, $root[0] ) ) {
				return array( 'type' => $root[1], 'slug' => $root[2] );
			}
		}
		$plugins = wp_normalize_path( WP_PLUGIN_DIR ) . '/';
		if ( 0 === strpos( $file, $plugins ) ) {
			// Single-file plugin such as hello.php.
			return array( 'type' => 'plugin', 'slug' => preg_replace( '/\.php$/', '', basename( $file ) ) );
		}
		if ( defined( 'WPMU_PLUGIN_DIR' ) && 0 === strpos( $file, wp_normalize_path( WPMU_PLUGIN_DIR ) . '/' ) ) {
			return array( 'type' => 'mu-plugin', 'slug' => preg_replace( '/\.php$/', '', basename( $file ) ) );
		}
		if ( dirname( $file ) === wp_normalize_path( WP_CONTENT_DIR ) ) {
			return array( 'type' => 'dropin', 'slug' => basename( $file ) );
		}
		$abspath = wp_normalize_path( ABSPATH );
		if ( dirname( $file ) . '/' === $abspath ) {
			return array( 'type' => 'core', 'slug' => null );
		}
		return array( 'type' => 'unknown', 'slug' => null );
	}

	/**
	 * Path relative to ABSPATH (or the plugin root when outside it), for compact output.
	 *
	 * @param string $file Absolute path.
	 * @return string
	 */
	private static function short_path( $file ) {
		$file = wp_normalize_path( (string) $file );
		foreach ( array( wp_normalize_path( WP_CONTENT_DIR ) . '/', wp_normalize_path( ABSPATH ) ) as $base ) {
			if ( 0 === strpos( $file, $base ) ) {
				return substr( $file, strlen( $base ) );
			}
		}
		foreach ( self::roots() as $root ) {
			if ( 0 === strpos( $file, $root[0] ) && $root[2] ) {
				return $root[2] . '/' . substr( $file, strlen( $root[0] ) );
			}
		}
		return $file;
	}

	/**
	 * Describe any PHP callable: name, file:line and owner.
	 *
	 * @param mixed $cb Callable.
	 * @return array
	 */
	public static function describe_callable( $cb ) {
		$out = array( 'callback' => 'unknown' );
		try {
			$ref = null;
			if ( is_string( $cb ) && false !== strpos( $cb, '::' ) ) {
				$cb = explode( '::', $cb, 2 );
			}
			if ( $cb instanceof Closure ) {
				$ref             = new ReflectionFunction( $cb );
				$out['callback'] = '{closure}';
				$this_obj        = $ref->getClosureThis();
				if ( $this_obj ) {
					$out['callback'] = '{closure} in ' . get_class( $this_obj );
				}
			} elseif ( is_string( $cb ) ) {
				$out['callback'] = $cb;
				if ( function_exists( $cb ) ) {
					$ref = new ReflectionFunction( $cb );
				} else {
					$out['missing'] = true;
				}
			} elseif ( is_array( $cb ) && 2 === count( $cb ) && isset( $cb[0], $cb[1] ) && is_string( $cb[1] ) ) {
				$class           = is_object( $cb[0] ) ? get_class( $cb[0] ) : (string) $cb[0];
				$out['callback'] = $class . ( is_object( $cb[0] ) ? '->' : '::' ) . $cb[1];
				if ( method_exists( $class, $cb[1] ) ) {
					$ref = new ReflectionMethod( $class, $cb[1] );
				} elseif ( class_exists( $class, false ) ) {
					$ref = new ReflectionClass( $class );
				} else {
					$out['missing'] = true;
				}
			} elseif ( is_object( $cb ) && method_exists( $cb, '__invoke' ) ) {
				$out['callback'] = get_class( $cb ) . '->__invoke';
				$ref             = new ReflectionMethod( get_class( $cb ), '__invoke' );
			}

			if ( $ref ) {
				$file = $ref->getFileName();
				if ( $file ) {
					$out['file']   = self::short_path( $file ) . ':' . (int) $ref->getStartLine();
					$out['source'] = self::source_of_file( $file );
				} else {
					$out['source'] = array( 'type' => 'php-internal', 'slug' => null );
				}
			}
		} catch ( Exception $e ) {
			$out['reflection_error'] = $e->getMessage();
		}
		return $out;
	}

	/**
	 * Source label for a registered object.
	 *
	 * @param string $kind post_type|taxonomy|block.
	 * @param string $name Name.
	 * @param bool   $builtin Whether core flagged it _builtin.
	 * @return array|null
	 */
	private static function registered_source( $kind, $name, $builtin = false ) {
		if ( $builtin ) {
			return array( 'type' => 'core', 'slug' => null );
		}
		if ( isset( self::$registered_in[ $kind ][ $name ] ) && self::$registered_in[ $kind ][ $name ] ) {
			return self::source_of_file( self::$registered_in[ $kind ][ $name ] );
		}
		return null;
	}

	/* ------------------------------------------------------------------ *
	 * Owner guessing by name prefix
	 * ------------------------------------------------------------------ */

	/**
	 * Installed plugins and themes: slug => status, plus text domains.
	 *
	 * @return array
	 */
	private static function installed() {
		static $cache = null;
		if ( null !== $cache ) {
			return $cache;
		}
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$active  = (array) get_option( 'active_plugins', array() );
		$slugs   = array();
		$domains = array();
		foreach ( get_plugins() as $file => $data ) {
			$slug           = false !== strpos( $file, '/' ) ? dirname( $file ) : preg_replace( '/\.php$/', '', $file );
			$status         = in_array( $file, $active, true ) || ( is_multisite() && is_plugin_active_for_network( $file ) ) ? 'active' : 'inactive';
			$slugs[ $slug ] = array( 'kind' => 'plugin', 'status' => $status );
			if ( ! empty( $data['TextDomain'] ) ) {
				$domains[ $data['TextDomain'] ] = $slug;
			}
		}
		if ( function_exists( 'get_mu_plugins' ) ) {
			foreach ( array_keys( get_mu_plugins() ) as $file ) {
				$slugs[ preg_replace( '/\.php$/', '', basename( $file ) ) ] = array( 'kind' => 'mu-plugin', 'status' => 'active' );
			}
		}
		$stylesheet = get_stylesheet();
		$template   = get_template();
		foreach ( array_keys( wp_get_themes() ) as $theme ) {
			if ( ! isset( $slugs[ $theme ] ) ) {
				$slugs[ $theme ] = array( 'kind' => 'theme', 'status' => ( $theme === $stylesheet || $theme === $template ) ? 'active' : 'inactive' );
			}
		}
		$cache = array( 'slugs' => $slugs, 'domains' => $domains );
		return $cache;
	}

	/**
	 * Best-effort owner of an option, meta key or table suffix, from its prefix.
	 *
	 * @param string $name Name with any WP prefix already removed.
	 * @return array|null { slug, kind, status: active|inactive|not_installed, via }
	 */
	public static function guess_owner( $name ) {
		$name = strtolower( ltrim( (string) $name, '_' ) );
		$name = preg_replace( '/^(site_)?transient_(timeout_)?/', '', $name );
		if ( '' === $name ) {
			return null;
		}
		if ( 0 === strpos( $name, 'theme_mods_' ) ) {
			$theme     = substr( $name, 11 );
			$installed = self::installed();
			return array(
				'slug'   => $theme,
				'kind'   => 'theme',
				'status' => isset( $installed['slugs'][ $theme ] ) ? $installed['slugs'][ $theme ]['status'] : 'not_installed',
				'via'    => 'theme_mods',
			);
		}

		$installed  = self::installed();
		$candidates = array();
		foreach ( $installed['slugs'] as $slug => $info ) {
			$candidates[ strtolower( str_replace( '-', '_', $slug ) ) ] = $slug;
		}
		foreach ( $installed['domains'] as $domain => $slug ) {
			$candidates[ strtolower( str_replace( '-', '_', $domain ) ) ] = $slug;
		}

		$normalized = str_replace( '-', '_', $name );
		$best       = null;
		$best_len   = 0;
		foreach ( $candidates as $prefix => $slug ) {
			$len = strlen( $prefix );
			if ( $len < 3 || $len <= $best_len ) {
				continue;
			}
			if ( 0 === strpos( $normalized, $prefix ) && ( strlen( $normalized ) === $len || '_' === $normalized[ $len ] ) ) {
				$best     = $slug;
				$best_len = $len;
			}
		}
		if ( $best ) {
			$info = $installed['slugs'][ $best ];
			return array( 'slug' => $best, 'kind' => $info['kind'], 'status' => $info['status'], 'via' => 'installed slug' );
		}

		foreach ( self::$known_prefixes as $prefix => $slug ) {
			if ( 0 !== strpos( $normalized, $prefix ) ) {
				continue;
			}
			$len  = strlen( $prefix );
			$next = strlen( $normalized ) > $len ? $normalized[ $len ] : '';
			if ( '_' === substr( $prefix, -1 ) || '' === $next || '_' === $next || $len >= 5 ) {
				$info = isset( $installed['slugs'][ $slug ] ) ? $installed['slugs'][ $slug ] : null;
				return array(
					'slug'   => $slug,
					'kind'   => $info ? $info['kind'] : 'plugin',
					'status' => $info ? $info['status'] : 'not_installed',
					'via'    => 'known prefix',
				);
			}
		}
		if ( 0 === strpos( $normalized, 'wp_' ) ) {
			return array( 'slug' => 'wordpress', 'kind' => 'core', 'status' => 'active', 'via' => 'wp_ prefix (core convention)' );
		}
		return null;
	}

	/**
	 * Whether an option name is one core creates.
	 *
	 * @param string $name Option name.
	 * @return bool
	 */
	public static function is_core_option( $name ) {
		global $wpdb;
		$name = strtolower( trim( (string) $name ) );
		if ( in_array( $name, self::$core_options, true ) ) {
			return true;
		}
		return strtolower( $wpdb->prefix . 'user_roles' ) === $name || '_user_roles' === substr( $name, -11 );
	}

	/* ------------------------------------------------------------------ *
	 * /registry
	 * ------------------------------------------------------------------ */

	/**
	 * Dispatch by kind.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function registry( $request ) {
		$kind   = (string) $request->get_param( 'kind' );
		$filter = trim( (string) $request->get_param( 'filter' ) );
		$limit  = max( 1, min( self::MAX_LIMIT, (int) $request->get_param( 'limit' ) ) );

		$map = array(
			'post_types'       => 'kind_post_types',
			'taxonomies'       => 'kind_taxonomies',
			'meta'             => 'kind_meta',
			'blocks'           => 'kind_blocks',
			'shortcodes'       => 'kind_shortcodes',
			'rest_routes'      => 'kind_rest_routes',
			'hooks'            => 'kind_hooks',
			'cron'             => 'kind_cron',
			'image_sizes'      => 'kind_image_sizes',
			'menus_locations'  => 'kind_menus_locations',
			'sidebars'         => 'kind_sidebars',
			'capabilities'     => 'kind_capabilities',
			'scripts_styles'   => 'kind_scripts_styles',
		);
		if ( ! isset( $map[ $kind ] ) ) {
			return new WP_Error( 'wpxmcp_bad_kind', sprintf( 'Unknown kind "%s". Valid kinds: %s.', $kind, implode( ', ', array_keys( $map ) ) ), array( 'status' => 400 ) );
		}
		$out = call_user_func( array( $this, $map[ $kind ] ), $filter, $limit );
		if ( is_wp_error( $out ) ) {
			return $out;
		}
		return array_merge( array( 'kind' => $kind, 'filter' => '' === $filter ? null : $filter, 'limit' => $limit ), $out );
	}

	/**
	 * Case-insensitive substring match over any of the given strings.
	 *
	 * @param string $filter Needle.
	 * @param array  $haystacks Strings.
	 * @return bool
	 */
	private static function matches( $filter, $haystacks ) {
		if ( '' === $filter ) {
			return true;
		}
		foreach ( $haystacks as $h ) {
			if ( is_scalar( $h ) && false !== stripos( (string) $h, $filter ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Cap a list and report the total.
	 *
	 * @param array  $items List.
	 * @param int    $limit Cap.
	 * @param string $key Output key.
	 * @return array
	 */
	private static function capped( $items, $limit, $key = 'items' ) {
		$items = array_values( $items );
		$out   = array(
			'total'    => count( $items ),
			'returned' => min( $limit, count( $items ) ),
			$key       => array_slice( $items, 0, $limit ),
		);
		if ( count( $items ) > $limit ) {
			$out['truncated'] = true;
		}
		return $out;
	}

	/**
	 * Rewrite settings, compactly.
	 *
	 * @param mixed $rewrite Rewrite arg.
	 * @return mixed
	 */
	private static function rewrite_summary( $rewrite ) {
		if ( ! is_array( $rewrite ) ) {
			return (bool) $rewrite;
		}
		return array(
			'slug'       => isset( $rewrite['slug'] ) ? $rewrite['slug'] : null,
			'with_front' => isset( $rewrite['with_front'] ) ? (bool) $rewrite['with_front'] : null,
		);
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_post_types( $filter, $limit ) {
		$items = array();
		foreach ( get_post_types( array(), 'objects' ) as $pt ) {
			if ( ! self::matches( $filter, array( $pt->name, $pt->label ) ) ) {
				continue;
			}
			$items[] = array(
				'name'            => $pt->name,
				'label'           => $pt->label,
				'public'          => (bool) $pt->public,
				'show_ui'         => (bool) $pt->show_ui,
				'show_in_rest'    => (bool) $pt->show_in_rest,
				'rest_base'       => $pt->show_in_rest ? ( $pt->rest_base ? $pt->rest_base : $pt->name ) : null,
				'rest_namespace'  => $pt->show_in_rest ? ( ! empty( $pt->rest_namespace ) ? $pt->rest_namespace : 'wp/v2' ) : null,
				'hierarchical'    => (bool) $pt->hierarchical,
				'has_archive'     => $pt->has_archive,
				'supports'        => array_keys( (array) get_all_post_type_supports( $pt->name ) ),
				'taxonomies'      => get_object_taxonomies( $pt->name ),
				'rewrite'         => self::rewrite_summary( $pt->rewrite ),
				'capability_type' => $pt->capability_type,
				'map_meta_cap'    => (bool) $pt->map_meta_cap,
				'builtin'         => (bool) $pt->_builtin,
				'source'          => self::registered_source( 'post_type', $pt->name, $pt->_builtin ),
			);
		}
		return self::capped( $items, $limit );
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_taxonomies( $filter, $limit ) {
		$items = array();
		foreach ( get_taxonomies( array(), 'objects' ) as $tax ) {
			if ( ! self::matches( $filter, array( $tax->name, $tax->label ) ) ) {
				continue;
			}
			$items[] = array(
				'name'           => $tax->name,
				'label'          => $tax->label,
				'object_types'   => (array) $tax->object_type,
				'public'         => (bool) $tax->public,
				'show_ui'        => (bool) $tax->show_ui,
				'show_in_rest'   => (bool) $tax->show_in_rest,
				'rest_base'      => $tax->show_in_rest ? ( $tax->rest_base ? $tax->rest_base : $tax->name ) : null,
				'rest_namespace' => $tax->show_in_rest ? ( ! empty( $tax->rest_namespace ) ? $tax->rest_namespace : 'wp/v2' ) : null,
				'hierarchical'   => (bool) $tax->hierarchical,
				'rewrite'        => self::rewrite_summary( $tax->rewrite ),
				'capabilities'   => isset( $tax->cap ) ? array_values( array_unique( array_values( (array) $tax->cap ) ) ) : array(),
				'builtin'        => (bool) $tax->_builtin,
				'source'         => self::registered_source( 'taxonomy', $tax->name, $tax->_builtin ),
			);
		}
		return self::capped( $items, $limit );
	}

	/**
	 * Registered meta plus the most frequent unregistered postmeta keys.
	 *
	 * @param string $filter Filter; include protected "_" keys by starting it with "_" or passing "protected".
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_meta( $filter, $limit ) {
		global $wp_meta_keys, $wpdb;

		$show_protected = ( '' !== $filter && '_' === $filter[0] ) || 'protected' === strtolower( $filter );
		$needle         = ( 'protected' === strtolower( $filter ) || '_' === $filter ) ? '' : $filter;

		$registered = array();
		$known      = array();
		foreach ( (array) $wp_meta_keys as $object_type => $subtypes ) {
			foreach ( (array) $subtypes as $subtype => $keys ) {
				foreach ( (array) $keys as $key => $args ) {
					$known[ $object_type . '|' . $key ] = true;
					if ( ! $show_protected && is_protected_meta( $key, $object_type ) ) {
						continue;
					}
					if ( ! self::matches( $needle, array( $key, $subtype ) ) ) {
						continue;
					}
					$registered[] = array(
						'object_type'  => $object_type,
						'subtype'      => '' === $subtype ? '*' : $subtype,
						'key'          => $key,
						'type'         => isset( $args['type'] ) ? $args['type'] : null,
						'single'       => ! empty( $args['single'] ),
						'show_in_rest' => ! empty( $args['show_in_rest'] ),
						'protected'    => is_protected_meta( $key, $object_type ),
						'has_auth_cb'  => ! empty( $args['auth_callback'] ),
					);
				}
			}
		}

		// Frequency scan of postmeta — uses the meta_key index.
		$scan = (int) min( 2000, max( 50, $limit * 5 ) );
		$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
			"SELECT meta_key, COUNT(*) AS c, AVG(LENGTH(meta_value)) AS avg_len FROM {$wpdb->postmeta} GROUP BY meta_key ORDER BY c DESC LIMIT %d",
			$scan
		), ARRAY_A );

		$unregistered = array();
		$hidden       = 0;
		foreach ( (array) $rows as $row ) {
			$key = (string) $row['meta_key'];
			if ( isset( $known[ 'post|' . $key ] ) ) {
				continue;
			}
			if ( ! $show_protected && '_' === substr( $key, 0, 1 ) ) {
				++$hidden;
				continue;
			}
			if ( ! self::matches( $needle, array( $key ) ) ) {
				continue;
			}
			$unregistered[] = array(
				'key'         => $key,
				'rows'        => (int) $row['c'],
				'avg_bytes'   => (int) round( (float) $row['avg_len'] ),
				'owner_guess' => self::guess_owner( $key ),
			);
		}

		$reg = self::capped( $registered, $limit, 'registered' );
		$unr = self::capped( $unregistered, $limit, 'unregistered_postmeta' );
		return array(
			'registered_total'             => $reg['total'],
			'registered'                   => $reg['registered'],
			'unregistered_postmeta_total'  => $unr['total'],
			'unregistered_postmeta'        => $unr['unregistered_postmeta'],
			'protected_keys_hidden'        => $show_protected ? 0 : $hidden,
			'note'                         => 'Unregistered keys are the ' . $scan . ' most frequent postmeta keys not passed through register_meta(); they are invisible to the REST API. Keys starting with "_" are hidden unless filter starts with "_" or is "protected".',
		);
	}

	/**
	 * Blocks, styles, variations and patterns.
	 *
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_blocks( $filter, $limit ) {
		$blocks = array();
		$styles_registry = class_exists( 'WP_Block_Styles_Registry' ) ? WP_Block_Styles_Registry::get_instance() : null;
		$variation_total = 0;
		foreach ( WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block ) {
			if ( ! self::matches( $filter, array( $name, $block->title, $block->category ) ) ) {
				continue;
			}
			$source = self::registered_source( 'block', $name );
			if ( ! $source && 0 === strpos( $name, 'core/' ) ) {
				$source = array( 'type' => 'core', 'slug' => null );
			}
			$variations = array();
			// The variations property is lazily computed in 6.5+; reading it is fine.
			$vars = method_exists( $block, 'get_variations' ) ? (array) $block->get_variations() : ( isset( $block->variations ) ? (array) $block->variations : array() );
			foreach ( $vars as $v ) {
				if ( is_array( $v ) && isset( $v['name'] ) ) {
					$variations[] = $v['name'];
				}
			}
			$variation_total += count( $variations );
			$styles           = $styles_registry ? array_keys( (array) $styles_registry->get_registered_styles_for_block( $name ) ) : array();
			foreach ( (array) $block->styles as $style ) {
				if ( is_array( $style ) && isset( $style['name'] ) && ! in_array( $style['name'], $styles, true ) ) {
					$styles[] = $style['name'];
				}
			}
			$blocks[]         = array(
				'name'             => $name,
				'title'            => $block->title,
				'category'         => $block->category,
				'api_version'      => isset( $block->api_version ) ? $block->api_version : null,
				'is_dynamic'       => $block->is_dynamic(),
				'attributes_count' => is_array( $block->attributes ) ? count( $block->attributes ) : 0,
				'supports'         => is_array( $block->supports ) ? array_keys( $block->supports ) : array(),
				'parent'           => $block->parent,
				'styles'           => $styles ? $styles : null,
				'variations'       => $variations ? array_slice( $variations, 0, 20 ) : null,
				'block_json'       => isset( self::$registered_in['block'][ $name ] ) && preg_match( '/block\.json$/', self::$registered_in['block'][ $name ] ) ? self::short_path( self::$registered_in['block'][ $name ] ) : null,
				'source'           => $source,
			);
		}

		$by_source = array();
		foreach ( $blocks as $b ) {
			$label               = $b['source'] ? $b['source']['type'] . ( $b['source']['slug'] ? ':' . $b['source']['slug'] : '' ) : 'unknown';
			$by_source[ $label ] = isset( $by_source[ $label ] ) ? $by_source[ $label ] + 1 : 1;
		}
		arsort( $by_source );

		// Non-core first: that is what a developer is usually looking for.
		usort( $blocks, static function ( $a, $b ) {
			$ac = 0 === strpos( $a['name'], 'core/' ) ? 1 : 0;
			$bc = 0 === strpos( $b['name'], 'core/' ) ? 1 : 0;
			return $ac === $bc ? strcmp( $a['name'], $b['name'] ) : $ac - $bc;
		} );

		$patterns = array();
		if ( class_exists( 'WP_Block_Patterns_Registry' ) ) {
			foreach ( WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $p ) {
				if ( ! self::matches( $filter, array( $p['name'], isset( $p['title'] ) ? $p['title'] : '' ) ) ) {
					continue;
				}
				$patterns[] = array(
					'name'       => $p['name'],
					'title'      => isset( $p['title'] ) ? $p['title'] : null,
					'categories' => isset( $p['categories'] ) ? $p['categories'] : array(),
					'inserter'   => isset( $p['inserter'] ) ? (bool) $p['inserter'] : true,
					'source'     => isset( $p['source'] ) ? $p['source'] : ( isset( $p['filePath'] ) ? self::source_of_file( $p['filePath'] ) : null ),
				);
			}
		}

		$out = self::capped( $blocks, $limit, 'blocks' );
		$pat = self::capped( $patterns, $limit, 'patterns' );
		return array(
			'total'            => $out['total'],
			'by_source'        => $by_source,
			'dynamic_count'    => count( array_filter( $blocks, static function ( $b ) {
				return $b['is_dynamic'];
			} ) ),
			'variations_total' => $variation_total,
			'blocks'           => $out['blocks'],
			'truncated'        => ! empty( $out['truncated'] ),
			'patterns_total'   => $pat['total'],
			'patterns'         => $pat['patterns'],
			'note'             => 'Block sources come from block.json paths or the registering file, captured during this request. Patterns from the remote pattern directory only appear once something has loaded them.',
		);
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_shortcodes( $filter, $limit ) {
		global $shortcode_tags;
		$items = array();
		foreach ( (array) $shortcode_tags as $tag => $cb ) {
			$desc = self::describe_callable( $cb );
			if ( ! self::matches( $filter, array( $tag, $desc['callback'], isset( $desc['source']['slug'] ) ? $desc['source']['slug'] : '' ) ) ) {
				continue;
			}
			$items[] = array_merge( array( 'tag' => $tag ), $desc );
		}
		return self::capped( $items, $limit, 'shortcodes' );
	}

	/**
	 * @param string $filter Namespace or route substring.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_rest_routes( $filter, $limit ) {
		$server     = rest_get_server();
		$routes     = $server->get_routes();
		$items      = array();
		$namespaces = array();
		$public     = 0;
		$missing    = 0;
		foreach ( $routes as $route => $handlers ) {
			$opts = $server->get_route_options( $route );
			$ns   = isset( $opts['namespace'] ) ? $opts['namespace'] : '';
			if ( '' !== $filter && $ns !== $filter && false === stripos( $route, $filter ) ) {
				continue;
			}
			$methods    = array();
			$permission = 'none';
			$first      = null;
			foreach ( (array) $handlers as $handler ) {
				if ( ! is_array( $handler ) ) {
					continue;
				}
				$methods = array_merge( $methods, array_keys( array_filter( (array) ( isset( $handler['methods'] ) ? $handler['methods'] : array() ) ) ) );
				if ( null === $first && isset( $handler['callback'] ) ) {
					$first = $handler;
				}
				if ( isset( $handler['permission_callback'] ) && $handler['permission_callback'] ) {
					$pc = $handler['permission_callback'];
					if ( '__return_true' === $pc ) {
						$permission = 'public';
					} elseif ( 'public' !== $permission ) {
						$permission = 'callback';
					}
				} elseif ( 'none' === $permission ) {
					$permission = 'missing';
				}
			}
			if ( '' === $ns || ( $first && is_array( $first['callback'] ) && isset( $first['callback'][1] ) && 'get_namespace_index' === $first['callback'][1] ) ) {
				$permission = 'index';
			}
			if ( 'public' === $permission ) {
				++$public;
			}
			if ( 'missing' === $permission ) {
				++$missing;
			}
			$namespaces[ $ns ] = isset( $namespaces[ $ns ] ) ? $namespaces[ $ns ] + 1 : 1;
			$row               = array(
				'route'      => $route,
				'namespace'  => $ns,
				'methods'    => array_values( array_unique( $methods ) ),
				'permission' => $permission,
			);
			if ( $first ) {
				$desc              = self::describe_callable( $first['callback'] );
				$row['callback']   = $desc['callback'];
				$row['file']       = isset( $desc['file'] ) ? $desc['file'] : null;
				$row['source']     = isset( $desc['source'] ) ? $desc['source'] : null;
			}
			$items[] = $row;
		}
		ksort( $namespaces );
		return array_merge(
			array(
				'namespaces'        => $namespaces,
				'public_routes'     => $public,
				'missing_permission'=> $missing,
				'legend'            => 'permission: "public" = permission_callback is __return_true (anyone can call it), "missing" = no permission_callback (core warns; treated as public), "callback" = a real check, "index" = namespace index route.',
			),
			self::capped( $items, $limit, 'routes' )
		);
	}

	/**
	 * @param string $filter Exact hook name, or a substring to find hooks.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_hooks( $filter, $limit ) {
		global $wp_filter;

		if ( '' !== $filter && isset( $wp_filter[ $filter ] ) && $wp_filter[ $filter ] instanceof WP_Hook ) {
			$callbacks = array();
			foreach ( $wp_filter[ $filter ]->callbacks as $priority => $group ) {
				foreach ( (array) $group as $entry ) {
					$desc        = self::describe_callable( $entry['function'] );
					$callbacks[] = array_merge(
						array( 'priority' => (int) $priority, 'accepted_args' => (int) $entry['accepted_args'] ),
						$desc
					);
				}
			}
			$out = self::capped( $callbacks, $limit, 'callbacks' );
			return array_merge( array( 'hook' => $filter, 'fired_count' => did_action( $filter ) ), $out, array(
				'note' => 'Callbacks attached while serving this REST request. Hooks added only on front-end or admin screens (e.g. inside wp_enqueue_scripts or admin_init callbacks) are not visible here.',
			) );
		}

		$hooks = array();
		foreach ( (array) $wp_filter as $name => $hook ) {
			if ( ! ( $hook instanceof WP_Hook ) ) {
				continue;
			}
			if ( '' !== $filter && false === stripos( (string) $name, $filter ) ) {
				continue;
			}
			$count = 0;
			foreach ( $hook->callbacks as $group ) {
				$count += count( (array) $group );
			}
			$hooks[] = array( 'hook' => (string) $name, 'callbacks' => $count );
		}
		usort( $hooks, static function ( $a, $b ) {
			return $b['callbacks'] - $a['callbacks'];
		} );
		$cap = '' === $filter ? min( 50, $limit ) : $limit;
		return array_merge( self::capped( $hooks, $cap, 'hooks' ), array(
			'note' => '' === $filter
				? 'Top hooks by callback count. Pass filter=<exact hook name> to list its callbacks with file:line and owner.'
				: 'No hook is named exactly "' . $filter . '"; these hook names contain it. Pass one exactly to list its callbacks.',
		) );
	}

	/**
	 * @param string $filter Hook substring.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_cron( $filter, $limit ) {
		$crons     = function_exists( '_get_cron_array' ) ? _get_cron_array() : array();
		$schedules = wp_get_schedules();
		$now       = time();
		$events    = array();
		$overdue   = 0;
		$orphans   = 0;
		foreach ( (array) $crons as $timestamp => $hooks ) {
			foreach ( (array) $hooks as $hook => $instances ) {
				if ( ! self::matches( $filter, array( $hook ) ) ) {
					continue;
				}
				foreach ( (array) $instances as $key => $event ) {
					$has_cb  = (bool) has_action( $hook );
					$is_late = (int) $timestamp < $now - 60;
					$overdue += $is_late ? 1 : 0;
					$orphans += $has_cb ? 0 : 1;
					$events[] = array(
						'hook'          => $hook,
						'next_run'      => gmdate( 'c', (int) $timestamp ),
						'next_run_in'   => self::relative( (int) $timestamp - $now ),
						'schedule'      => ! empty( $event['schedule'] ) ? $event['schedule'] : 'single',
						'interval'      => isset( $event['interval'] ) ? (int) $event['interval'] : null,
						'args_hash'     => $key,
						'args_count'    => isset( $event['args'] ) ? count( (array) $event['args'] ) : 0,
						'overdue'       => $is_late,
						'callbacks'     => $has_cb ? self::hook_callback_count( $hook ) : 0,
						'orphan'        => ! $has_cb,
					);
				}
			}
		}
		$sched = array();
		foreach ( $schedules as $name => $s ) {
			$sched[] = array( 'name' => $name, 'interval' => (int) $s['interval'], 'display' => $s['display'] );
		}
		return array_merge(
			array(
				'now'            => gmdate( 'c', $now ),
				'wp_cron_disabled' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
				'overdue'        => $overdue,
				'orphans'        => $orphans,
				'schedules'      => $sched,
				'note'           => 'orphan = no callback is attached to the hook during a REST request (often the plugin that scheduled it is gone, though a callback registered only on admin/front-end requests also looks orphaned). overdue = more than a minute past due.',
			),
			self::capped( $events, $limit, 'events' )
		);
	}

	/**
	 * @param string $hook Hook.
	 * @return int
	 */
	private static function hook_callback_count( $hook ) {
		global $wp_filter;
		$count = 0;
		if ( isset( $wp_filter[ $hook ] ) && $wp_filter[ $hook ] instanceof WP_Hook ) {
			foreach ( $wp_filter[ $hook ]->callbacks as $group ) {
				$count += count( (array) $group );
			}
		}
		return $count;
	}

	/**
	 * "in 5m" / "3h ago".
	 *
	 * @param int $seconds Delta.
	 * @return string
	 */
	private static function relative( $seconds ) {
		$abs = abs( $seconds );
		if ( $abs < 60 ) {
			$text = $abs . 's';
		} elseif ( $abs < 3600 ) {
			$text = floor( $abs / 60 ) . 'm';
		} elseif ( $abs < 86400 ) {
			$text = floor( $abs / 3600 ) . 'h';
		} else {
			$text = floor( $abs / 86400 ) . 'd';
		}
		return $seconds >= 0 ? 'in ' . $text : $text . ' ago';
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_image_sizes( $filter, $limit ) {
		$items = array();
		foreach ( wp_get_registered_image_subsizes() as $name => $size ) {
			if ( ! self::matches( $filter, array( $name ) ) ) {
				continue;
			}
			$items[] = array(
				'name'   => $name,
				'width'  => (int) $size['width'],
				'height' => (int) $size['height'],
				'crop'   => $size['crop'],
				'core'   => in_array( $name, array( 'thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048' ), true ),
			);
		}
		return array_merge( self::capped( $items, $limit, 'sizes' ), array(
			'big_image_size_threshold' => apply_filters( 'big_image_size_threshold', 2560, array( 0, 0 ), '', 0 ),
		) );
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_menus_locations( $filter, $limit ) {
		$assigned = get_nav_menu_locations();
		$items    = array();
		foreach ( get_registered_nav_menus() as $location => $description ) {
			if ( ! self::matches( $filter, array( $location, $description ) ) ) {
				continue;
			}
			$menu_id = isset( $assigned[ $location ] ) ? (int) $assigned[ $location ] : 0;
			$menu    = $menu_id ? wp_get_nav_menu_object( $menu_id ) : null;
			$items[] = array(
				'location'    => $location,
				'description' => $description,
				'menu_id'     => $menu ? (int) $menu->term_id : null,
				'menu_name'   => $menu ? $menu->name : null,
				'menu_items'  => $menu ? (int) $menu->count : null,
			);
		}
		$menus = array();
		foreach ( wp_get_nav_menus() as $m ) {
			$menus[] = array( 'id' => (int) $m->term_id, 'name' => $m->name, 'items' => (int) $m->count );
		}
		return array_merge( self::capped( $items, $limit, 'locations' ), array(
			'menus'          => array_slice( $menus, 0, $limit ),
			'block_theme'    => function_exists( 'wp_is_block_theme' ) && wp_is_block_theme(),
			'note'           => function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() ? 'Block themes use wp_navigation posts in templates; classic locations may be empty.' : null,
		) );
	}

	/**
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_sidebars( $filter, $limit ) {
		global $wp_registered_sidebars;
		$widgets = wp_get_sidebars_widgets();
		$items   = array();
		foreach ( (array) $wp_registered_sidebars as $id => $sidebar ) {
			if ( ! self::matches( $filter, array( $id, $sidebar['name'] ) ) ) {
				continue;
			}
			$items[] = array(
				'id'          => $id,
				'name'        => $sidebar['name'],
				'description' => isset( $sidebar['description'] ) ? $sidebar['description'] : '',
				'widgets'     => isset( $widgets[ $id ] ) ? count( (array) $widgets[ $id ] ) : 0,
			);
		}
		return array_merge( self::capped( $items, $limit, 'sidebars' ), array(
			'inactive_widgets' => isset( $widgets['wp_inactive_widgets'] ) ? count( (array) $widgets['wp_inactive_widgets'] ) : 0,
		) );
	}

	/**
	 * Roles with their capability diff against a fresh install.
	 *
	 * @param string $filter Filter.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_capabilities( $filter, $limit ) {
		$levels   = static function ( $max ) {
			$out = array();
			for ( $i = 0; $i <= $max; $i++ ) {
				$out[] = 'level_' . $i;
			}
			return implode( ' ', $out );
		};
		$author   = 'upload_files edit_posts edit_published_posts publish_posts read delete_posts delete_published_posts';
		$editor   = 'moderate_comments manage_categories manage_links upload_files unfiltered_html edit_posts edit_others_posts edit_published_posts publish_posts edit_pages read edit_others_pages edit_published_pages publish_pages delete_pages delete_others_pages delete_published_pages delete_posts delete_others_posts delete_published_posts delete_private_posts edit_private_posts read_private_posts delete_private_pages edit_private_pages read_private_pages';
		$defaults = array(
			'administrator' => 'switch_themes edit_themes activate_plugins edit_plugins edit_users edit_files manage_options import delete_users create_users unfiltered_upload edit_dashboard update_plugins delete_plugins install_plugins update_themes install_themes update_core list_users remove_users promote_users edit_theme_options delete_themes export ' . $editor . ' ' . $levels( 10 ),
			'editor'        => $editor . ' ' . $levels( 7 ),
			'author'        => $author . ' ' . $levels( 2 ),
			'contributor'   => 'edit_posts read delete_posts ' . $levels( 1 ),
			'subscriber'    => 'read level_0',
		);

		$counts = count_users();
		$items  = array();
		foreach ( wp_roles()->roles as $slug => $role ) {
			if ( ! self::matches( $filter, array( $slug, $role['name'] ) ) ) {
				continue;
			}
			$caps = array_keys( array_filter( (array) $role['capabilities'] ) );
			$row  = array(
				'role'      => $slug,
				'name'      => $role['name'],
				'users'     => isset( $counts['avail_roles'][ $slug ] ) ? (int) $counts['avail_roles'][ $slug ] : 0,
				'cap_count' => count( $caps ),
				'core_role' => isset( $defaults[ $slug ] ),
			);
			if ( isset( $defaults[ $slug ] ) ) {
				$default           = array_unique( explode( ' ', $defaults[ $slug ] ) );
				$row['added']      = array_values( array_diff( $caps, $default ) );
				$row['removed']    = array_values( array_diff( $default, $caps ) );
			} else {
				$row['capabilities'] = array_slice( $caps, 0, 100 );
			}
			$items[] = $row;
		}
		return self::capped( $items, $limit, 'roles' );
	}

	/**
	 * @param string $filter Handle or src substring.
	 * @param int    $limit Limit.
	 * @return array
	 */
	private function kind_scripts_styles( $filter, $limit ) {
		$out = array(
			'note' => 'These are handles registered while serving a REST request (core defaults plus anything plugins register on init). Most plugins register and enqueue on wp_enqueue_scripts/admin_enqueue_scripts, which do not fire here — profile a front-end URL (profile_url) to see what a page actually enqueues.',
		);
		foreach ( array( 'scripts' => wp_scripts(), 'styles' => wp_styles() ) as $key => $deps ) {
			$items  = array();
			$counts = array();
			foreach ( $deps->registered as $handle => $dep ) {
				$src    = is_string( $dep->src ) ? $dep->src : '';
				$source = self::source_of_url( $src );
				$label  = $source['type'] . ( $source['slug'] ? ':' . $source['slug'] : '' );
				$counts[ $label ] = isset( $counts[ $label ] ) ? $counts[ $label ] + 1 : 1;
				if ( ! self::matches( $filter, array( $handle, $src ) ) ) {
					continue;
				}
				$items[] = array(
					'handle' => $handle,
					'src'    => '' === $src ? null : $src,
					'deps'   => (array) $dep->deps,
					'ver'    => $dep->ver,
					'source' => $source,
				);
			}
			usort( $items, static function ( $a, $b ) {
				$ac = 'core' === $a['source']['type'] ? 1 : 0;
				$bc = 'core' === $b['source']['type'] ? 1 : 0;
				return $ac === $bc ? strcmp( $a['handle'], $b['handle'] ) : $ac - $bc;
			} );
			arsort( $counts );
			$out[ $key ] = array_merge( array( 'by_source' => $counts ), self::capped( $items, $limit, 'handles' ) );
		}
		return $out;
	}

	/**
	 * Owner of an asset URL.
	 *
	 * @param string $src URL or root-relative path.
	 * @return array
	 */
	private static function source_of_url( $src ) {
		if ( '' === $src ) {
			return array( 'type' => 'core', 'slug' => null );
		}
		$path = (string) wp_parse_url( $src, PHP_URL_PATH );
		if ( preg_match( '#^/?(wp-includes|wp-admin)/#', ltrim( $path ) ) ) {
			return array( 'type' => 'core', 'slug' => null );
		}
		$map = array(
			'plugin'    => wp_parse_url( plugins_url(), PHP_URL_PATH ),
			'mu-plugin' => wp_parse_url( content_url( 'mu-plugins' ), PHP_URL_PATH ),
			'theme'     => wp_parse_url( get_theme_root_uri(), PHP_URL_PATH ),
		);
		foreach ( $map as $type => $base ) {
			$base = rtrim( (string) $base, '/' ) . '/';
			$pos  = '/' !== $base ? strpos( $path, $base ) : false;
			if ( false !== $pos ) {
				$rest = substr( $path, $pos + strlen( $base ) );
				$slug = strtok( $rest, '/' );
				return array( 'type' => $type, 'slug' => $slug ? $slug : null );
			}
		}
		if ( preg_match( '#/wp-includes/|/wp-admin/#', $path ) ) {
			return array( 'type' => 'core', 'slug' => null );
		}
		return array( 'type' => 'external', 'slug' => (string) wp_parse_url( $src, PHP_URL_HOST ) );
	}

	/* ------------------------------------------------------------------ *
	 * /options/report
	 * ------------------------------------------------------------------ */

	/**
	 * Autoload weight, ownership and transient hygiene.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function options_report( $request ) {
		global $wpdb;
		$limit    = max( 1, min( 200, (int) $request->get_param( 'limit' ) ) );
		$autoload = WPXMCP_REST::autoload_in_sql();

		$totals = $wpdb->get_row( "SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(option_value)),0) AS b FROM {$wpdb->options} WHERE autoload IN ($autoload)", ARRAY_A ); // phpcs:ignore WordPress.DB
		$all    = $wpdb->get_row( "SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(option_value)),0) AS b FROM {$wpdb->options}", ARRAY_A ); // phpcs:ignore WordPress.DB
		$bytes  = (int) $totals['b'];
		$limit_bytes = (int) apply_filters( 'site_status_autoloaded_options_size_limit', self::AUTOLOAD_WARN_BYTES );

		$top = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
			"SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE autoload IN ($autoload) ORDER BY len DESC LIMIT %d",
			$limit
		), ARRAY_A );

		$largest = array();
		foreach ( (array) $top as $row ) {
			$largest[] = array(
				'name'      => $row['option_name'],
				'bytes'     => (int) $row['len'],
				'autoload'  => $row['autoload'],
				'core'      => self::is_core_option( $row['option_name'] ),
				'protected' => wpxmcp_is_protected_option( $row['option_name'] ),
				'owner'     => self::is_core_option( $row['option_name'] ) ? array( 'slug' => 'wordpress', 'kind' => 'core', 'status' => 'active', 'via' => 'core option' ) : self::guess_owner( $row['option_name'] ),
			);
		}

		// Per-owner rollup over every autoloaded option (names and lengths only).
		$rows   = $wpdb->get_results( "SELECT option_name, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE autoload IN ($autoload) LIMIT 20000", ARRAY_A ); // phpcs:ignore WordPress.DB
		$owners = array();
		foreach ( (array) $rows as $row ) {
			if ( self::is_core_option( $row['option_name'] ) ) {
				$key   = 'core';
				$owner = array( 'slug' => 'wordpress', 'kind' => 'core', 'status' => 'active' );
			} elseif ( 0 === strpos( $row['option_name'], '_transient_' ) || 0 === strpos( $row['option_name'], '_site_transient_' ) ) {
				$key   = 'transients';
				$owner = array( 'slug' => 'transients', 'kind' => 'transient', 'status' => null );
			} else {
				$owner = self::guess_owner( $row['option_name'] );
				$key   = $owner ? $owner['slug'] : 'unattributed';
			}
			if ( ! isset( $owners[ $key ] ) ) {
				$owners[ $key ] = array(
					'owner'   => $key,
					'kind'    => $owner ? $owner['kind'] : null,
					'status'  => $owner ? $owner['status'] : null,
					'options' => 0,
					'bytes'   => 0,
				);
			}
			++$owners[ $key ]['options'];
			$owners[ $key ]['bytes'] += (int) $row['len'];
		}
		usort( $owners, static function ( $a, $b ) {
			return $b['bytes'] - $a['bytes'];
		} );
		$leftovers = array_values( array_filter( $owners, static function ( $o ) {
			return in_array( $o['status'], array( 'inactive', 'not_installed' ), true );
		} ) );

		return array(
			'autoload'   => array(
				'count'             => (int) $totals['c'],
				'bytes'             => $bytes,
				'kb'                => round( $bytes / 1024, 1 ),
				'warn_threshold'    => $limit_bytes,
				'status'            => $bytes > $limit_bytes ? 'warn' : 'ok',
				'message'           => $bytes > $limit_bytes
					? sprintf( 'Autoloaded options total %s KB, above the %s KB Site Health threshold. Every request loads them. Turn autoload off for large options that are not needed on every page (cleanup_options set_autoload_off).', round( $bytes / 1024 ), round( $limit_bytes / 1024 ) )
					: 'Autoloaded options are within the Site Health threshold.',
				'autoload_values'   => function_exists( 'wp_autoload_values_to_autoload' ) ? wp_autoload_values_to_autoload() : array( 'yes' ),
				'largest'           => $largest,
			),
			'all_options'           => array( 'count' => (int) $all['c'], 'bytes' => (int) $all['b'] ),
			'owners'                => array_slice( $owners, 0, 20 ),
			'owner_not_active'      => array_slice( $leftovers, 0, 20 ),
			'transients'            => $this->transient_report( '_transient_', $limit ),
			'site_transients'       => $this->transient_report( '_site_transient_', $limit ),
			'external_object_cache' => (bool) wp_using_ext_object_cache(),
			'notes'                 => array_values( array_filter( array(
				wp_using_ext_object_cache() ? 'A persistent object cache is active, so new transients live there, not in the options table; rows here are leftovers.' : null,
				is_multisite() ? 'Multisite: site transients are stored in the sitemeta table and are not counted here.' : null,
				'Owners are guessed from name prefixes against installed plugin/theme slugs and text domains — verify before deleting.',
			) ) ),
		);
	}

	/**
	 * Transient counts, expiry and orphans for one prefix.
	 *
	 * @param string $prefix _transient_ or _site_transient_.
	 * @param int    $limit Largest list size.
	 * @return array
	 */
	private function transient_report( $prefix, $limit ) {
		global $wpdb;
		$cap          = 50000;
		$timeout_like = $wpdb->esc_like( $prefix . 'timeout_' ) . '%';
		$value_like   = $wpdb->esc_like( $prefix ) . '%';

		$timeouts = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
			"SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT %d",
			$timeout_like,
			$cap
		), ARRAY_A );
		$values   = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
			"SELECT option_name, LENGTH(option_value) AS len, autoload FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name NOT LIKE %s LIMIT %d",
			$value_like,
			$timeout_like,
			$cap
		), ARRAY_A );

		$now         = time();
		$plen        = strlen( $prefix );
		$tlen        = strlen( $prefix . 'timeout_' );
		$expiry      = array();
		foreach ( (array) $timeouts as $row ) {
			$expiry[ substr( $row['option_name'], $tlen ) ] = (int) $row['option_value'];
		}
		$sizes = array();
		$total_bytes = 0;
		$autoloaded  = 0;
		foreach ( (array) $values as $row ) {
			$name           = substr( $row['option_name'], $plen );
			$sizes[ $name ] = (int) $row['len'];
			$total_bytes   += (int) $row['len'];
			if ( 'no' !== $row['autoload'] && 'off' !== $row['autoload'] && 'auto-off' !== $row['autoload'] ) {
				++$autoloaded;
			}
		}

		$expired_count  = 0;
		$expired_bytes  = 0;
		$orphan_timeout = 0;
		foreach ( $expiry as $name => $ts ) {
			if ( ! isset( $sizes[ $name ] ) ) {
				++$orphan_timeout;
				continue;
			}
			if ( $ts < $now ) {
				++$expired_count;
				$expired_bytes += $sizes[ $name ];
			}
		}
		$no_timeout = 0;
		foreach ( $sizes as $name => $len ) {
			if ( ! isset( $expiry[ $name ] ) ) {
				++$no_timeout;
			}
		}

		arsort( $sizes );
		$largest = array();
		foreach ( array_slice( $sizes, 0, min( 20, $limit ), true ) as $name => $len ) {
			$largest[] = array(
				'name'       => (string) $name,
				'bytes'      => $len,
				'expires'    => isset( $expiry[ $name ] ) ? gmdate( 'c', $expiry[ $name ] ) : null,
				'expired'    => isset( $expiry[ $name ] ) && $expiry[ $name ] < $now,
				'owner'      => self::guess_owner( (string) $name ),
			);
		}

		return array(
			'count'                  => count( $sizes ),
			'bytes'                  => $total_bytes,
			'autoloaded'             => $autoloaded,
			'expired_count'          => $expired_count,
			'expired_bytes'          => $expired_bytes,
			'orphan_timeouts'        => $orphan_timeout,
			'values_without_timeout' => $no_timeout,
			'largest'                => $largest,
			'truncated'              => count( (array) $timeouts ) >= $cap || count( (array) $values ) >= $cap,
			'legend'                 => 'orphan_timeouts = timeout rows with no value (safe to delete). values_without_timeout = transients set with no expiry; legitimate, but they never clean themselves up.',
		);
	}

	/* ------------------------------------------------------------------ *
	 * /options/cleanup
	 * ------------------------------------------------------------------ */

	/**
	 * Delete expired transients, turn autoload off, or delete options.
	 * Dry run unless dry_run is explicitly false.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function options_cleanup( $request ) {
		global $wpdb;
		$action  = (string) $request->get_param( 'action' );
		$raw     = $request->get_param( 'dry_run' );
		$dry_run = null === $raw ? true : rest_sanitize_boolean( $raw );
		$names   = $request->get_param( 'names' );
		$names   = array_values( array_unique( array_filter( array_map( 'trim', array_map( 'strval', is_array( $names ) ? $names : array() ) ), 'strlen' ) ) );

		if ( ! in_array( $action, array( 'delete_expired_transients', 'set_autoload_off', 'delete_options' ), true ) ) {
			return new WP_Error( 'wpxmcp_bad_action', 'action must be delete_expired_transients, set_autoload_off or delete_options.', array( 'status' => 400 ) );
		}
		if ( count( $names ) > 200 ) {
			return new WP_Error( 'wpxmcp_too_many', 'At most 200 option names per call.', array( 'status' => 400 ) );
		}

		if ( 'delete_expired_transients' === $action ) {
			return $this->cleanup_transients( $dry_run );
		}

		if ( ! $names ) {
			return new WP_Error( 'wpxmcp_no_names', sprintf( '%s needs `names`.', $action ), array( 'status' => 400 ) );
		}

		$changes = array();
		$refused = array();
		$skipped = array();
		$saved   = 0;
		foreach ( $names as $name ) {
			if ( wpxmcp_is_protected_option( $name ) ) {
				$refused[] = array( 'name' => $name, 'reason' => 'protected option (lock-out, connection or wpxmcp guard state)' );
				continue;
			}
			if ( self::is_core_option( $name ) ) {
				$refused[] = array( 'name' => $name, 'reason' => 'core WordPress option — created by every install and read on every request' );
				continue;
			}
			$row = $wpdb->get_row( $wpdb->prepare( "SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE option_name = %s", $name ), ARRAY_A ); // phpcs:ignore WordPress.DB
			if ( ! $row ) {
				$skipped[] = array( 'name' => $name, 'reason' => 'no such option' );
				continue;
			}
			$is_autoloaded = in_array( $row['autoload'], function_exists( 'wp_autoload_values_to_autoload' ) ? wp_autoload_values_to_autoload() : array( 'yes' ), true );
			if ( 'set_autoload_off' === $action && ! $is_autoloaded ) {
				$skipped[] = array( 'name' => $name, 'reason' => 'already not autoloaded (' . $row['autoload'] . ')' );
				continue;
			}
			$bytes     = (int) $row['len'];
			$saved    += $bytes;
			$changes[] = array(
				'name'     => $row['option_name'],
				'bytes'    => $bytes,
				'autoload' => $row['autoload'],
				'owner'    => self::guess_owner( $row['option_name'] ),
			);
		}

		$applied = array();
		if ( ! $dry_run && $changes ) {
			if ( 'set_autoload_off' === $action ) {
				$list = array();
				foreach ( $changes as $c ) {
					$list[ $c['name'] ] = false;
				}
				if ( function_exists( 'wp_set_option_autoload_values' ) ) {
					$result = wp_set_option_autoload_values( $list );
					foreach ( $changes as $c ) {
						$applied[ $c['name'] ] = ! empty( $result[ $c['name'] ] );
					}
				} else {
					foreach ( $changes as $c ) {
						$applied[ $c['name'] ] = false !== $wpdb->update( $wpdb->options, array( 'autoload' => 'no' ), array( 'option_name' => $c['name'] ) ); // phpcs:ignore WordPress.DB
					}
					wp_cache_delete( 'alloptions', 'options' );
				}
			} else {
				foreach ( $changes as $c ) {
					$applied[ $c['name'] ] = delete_option( $c['name'] );
				}
			}
			wpxmcp_audit( 'options cleanup ' . $action, array(
				'names' => array_keys( $applied ),
				'bytes' => $saved,
			) );
		}

		return array(
			'action'      => $action,
			'dry_run'     => $dry_run,
			'changes'     => $changes,
			'bytes_saved' => $saved,
			'refused'     => $refused,
			'skipped'     => $skipped,
			'applied'     => $dry_run ? null : $applied,
			'note'        => 'set_autoload_off' === $action
				? 'bytes_saved is the weight removed from every request\'s autoload; the options still exist and load on demand.'
				: 'bytes_saved is removed from the options table. Deleting an option a plugin still uses resets that plugin\'s setting.',
		);
	}

	/**
	 * Expired transients (with their timeout rows) plus orphaned timeout rows.
	 *
	 * @param bool $dry_run Preview only.
	 * @return array
	 */
	private function cleanup_transients( $dry_run ) {
		global $wpdb;
		$cap     = 5000;
		$now     = time();
		$items   = array();
		$orphans = array();
		$bytes   = 0;

		foreach ( array( '_transient_', '_site_transient_' ) as $prefix ) {
			$tlen = strlen( $prefix . 'timeout_' );
			$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT t.option_name AS timeout_name, v.option_name AS value_name, LENGTH(v.option_value) AS len, LENGTH(t.option_value) AS tlen
				FROM {$wpdb->options} t LEFT JOIN {$wpdb->options} v ON v.option_name = CONCAT(%s, SUBSTRING(t.option_name, %d))
				WHERE t.option_name LIKE %s AND t.option_value + 0 < %d LIMIT %d",
				$prefix,
				$tlen + 1,
				$wpdb->esc_like( $prefix . 'timeout_' ) . '%',
				$now,
				$cap
			), ARRAY_A );
			foreach ( (array) $rows as $row ) {
				$name = substr( $row['timeout_name'], $tlen );
				$b    = (int) $row['len'] + (int) $row['tlen'];
				if ( null === $row['value_name'] ) {
					continue; // Orphans are collected below regardless of their timestamp.
				}
				$bytes  += $b;
				$items[] = array( 'transient' => $name, 'site' => '_site_transient_' === $prefix, 'bytes' => $b );
			}

			$orphan_rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT t.option_name AS timeout_name, LENGTH(t.option_value) AS tlen
				FROM {$wpdb->options} t LEFT JOIN {$wpdb->options} v ON v.option_name = CONCAT(%s, SUBSTRING(t.option_name, %d))
				WHERE t.option_name LIKE %s AND v.option_id IS NULL LIMIT %d",
				$prefix,
				$tlen + 1,
				$wpdb->esc_like( $prefix . 'timeout_' ) . '%',
				$cap
			), ARRAY_A );
			foreach ( (array) $orphan_rows as $row ) {
				$bytes    += (int) $row['tlen'];
				$orphans[] = $row['timeout_name'];
			}
		}

		$deleted = 0;
		if ( ! $dry_run ) {
			foreach ( $items as $item ) {
				$ok = $item['site'] ? delete_site_transient( $item['transient'] ) : delete_transient( $item['transient'] );
				$deleted += $ok ? 1 : 0;
			}
			foreach ( $orphans as $name ) {
				$deleted += delete_option( $name ) ? 1 : 0;
			}
			wpxmcp_audit( 'options cleanup delete_expired_transients', array(
				'transients'      => count( $items ),
				'orphan_timeouts' => count( $orphans ),
				'bytes'           => $bytes,
			) );
		}

		return array(
			'action'          => 'delete_expired_transients',
			'dry_run'         => $dry_run,
			'expired_count'   => count( $items ),
			'orphan_timeouts' => count( $orphans ),
			'bytes_saved'     => $bytes,
			'changes'         => array_slice( $items, 0, 100 ),
			'orphan_sample'   => array_slice( $orphans, 0, 20 ),
			'capped_at'       => $cap,
			'deleted'         => $dry_run ? null : $deleted,
			'note'            => 'Expired transients are deleted through delete_transient()/delete_site_transient() so hooks and caches stay consistent. Timeout rows with no value are removed directly.',
		);
	}

	/* ------------------------------------------------------------------ *
	 * /database
	 * ------------------------------------------------------------------ */

	/**
	 * Whether the SQLite integration drives $wpdb.
	 *
	 * @return bool
	 */
	private static function is_sqlite() {
		global $wpdb;
		return ( defined( 'DB_ENGINE' ) && 'sqlite' === DB_ENGINE ) || ( is_object( $wpdb ) && false !== stripos( get_class( $wpdb ), 'sqlite' ) );
	}

	/**
	 * Run a scalar query, returning null (and noting the error) on failure.
	 *
	 * @param string $sql SQL.
	 * @param array  $errors Collected errors.
	 * @param string $label Label.
	 * @return int|null
	 */
	private static function scalar( $sql, &$errors, $label ) {
		global $wpdb;
		$suppress = $wpdb->suppress_errors( true );
		$value    = $wpdb->get_var( $sql ); // phpcs:ignore WordPress.DB
		$error    = $wpdb->last_error;
		$wpdb->suppress_errors( $suppress );
		if ( $error ) {
			$errors[ $label ] = $error;
			return null;
		}
		return null === $value ? 0 : (int) $value;
	}

	/**
	 * Table sizes, ownership and orphaned rows.
	 *
	 * @return array
	 */
	public function database() {
		global $wpdb;
		$sqlite = self::is_sqlite();
		$errors = array();
		$notes  = array();
		$cap    = 100000;

		$suppress = $wpdb->suppress_errors( true );
		$status   = $wpdb->get_results( 'SHOW TABLE STATUS', ARRAY_A ); // phpcs:ignore WordPress.DB
		$wpdb->suppress_errors( $suppress );
		if ( ! $status && $sqlite ) {
			$names  = $wpdb->get_col( "SELECT name FROM sqlite_master WHERE type = 'table'" ); // phpcs:ignore WordPress.DB
			$status = array();
			foreach ( (array) $names as $n ) {
				$status[] = array( 'Name' => $n );
			}
		}

		$core_tables = array_values( $wpdb->tables( 'all', true ) );
		$prefix      = $wpdb->prefix;
		$tables      = array();
		$total       = 0;
		$overhead    = 0;
		$charset     = array();
		foreach ( (array) $status as $i => $t ) {
			$name = $t['Name'];
			if ( 0 === strpos( $name, '_wp_sqlite_' ) || 0 === strpos( $name, 'sqlite_' ) ) {
				continue;
			}
			$data  = isset( $t['Data_length'] ) ? (int) $t['Data_length'] : null;
			$index = isset( $t['Index_length'] ) ? (int) $t['Index_length'] : null;
			$free  = isset( $t['Data_free'] ) ? (int) $t['Data_free'] : null;
			$rows  = isset( $t['Rows'] ) ? (int) $t['Rows'] : null;
			if ( $sqlite && $i < 300 ) {
				// The emulated status reports zeros; count exactly (SQLite tables here are small).
				$rows = self::scalar( 'SELECT COUNT(*) FROM `' . esc_sql( $name ) . '`', $errors, 'count ' . $name );
			}
			$row = array(
				'table'       => $name,
				'engine'      => $sqlite ? 'sqlite' : ( isset( $t['Engine'] ) ? $t['Engine'] : null ),
				'collation'   => isset( $t['Collation'] ) ? $t['Collation'] : null,
				'rows'        => $rows,
				'data_bytes'  => $sqlite ? null : $data,
				'index_bytes' => $sqlite ? null : $index,
				'overhead'    => $sqlite ? null : $free,
				'owner'       => $this->table_owner( $name, $core_tables, $prefix ),
			);
			if ( ! $sqlite ) {
				$total    += (int) $data + (int) $index;
				$overhead += (int) $free;
				if ( $row['collation'] && 0 !== strpos( $row['collation'], 'utf8mb4' ) ) {
					$charset[] = array( 'table' => $name, 'collation' => $row['collation'] );
				}
			}
			$tables[] = $row;
		}
		usort( $tables, static function ( $a, $b ) {
			$as = (int) $a['data_bytes'] + (int) $a['index_bytes'];
			$bs = (int) $b['data_bytes'] + (int) $b['index_bytes'];
			return $as === $bs ? (int) $b['rows'] - (int) $a['rows'] : $bs - $as;
		} );

		$orphan_tables = array();
		foreach ( $tables as $t ) {
			if ( in_array( $t['owner']['status'], array( 'unknown', 'not_installed', 'inactive', 'foreign_prefix' ), true ) ) {
				$orphan_tables[] = array(
					'table'  => $t['table'],
					'rows'   => $t['rows'],
					'bytes'  => $sqlite ? null : (int) $t['data_bytes'] + (int) $t['index_bytes'],
					'owner'  => $t['owner'],
				);
			}
		}

		// Orphaned rows, counted through a capped derived table so a huge
		// postmeta cannot pin the database.
		$capped = static function ( $inner, $label ) use ( &$errors, $cap ) {
			$n = self::scalar( "SELECT COUNT(*) FROM ( $inner LIMIT $cap ) AS x", $errors, $label );
			return null === $n ? null : ( $n >= $cap ? $cap . '+' : $n );
		};
		$orphans = array(
			'postmeta_without_post'       => $capped( "SELECT 1 FROM {$wpdb->postmeta} pm LEFT JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.ID IS NULL", 'postmeta' ),
			'commentmeta_without_comment' => $capped( "SELECT 1 FROM {$wpdb->commentmeta} cm LEFT JOIN {$wpdb->comments} c ON c.comment_ID = cm.comment_id WHERE c.comment_ID IS NULL", 'commentmeta' ),
			'term_relationships_without_object' => $capped( "SELECT 1 FROM {$wpdb->term_relationships} tr INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id LEFT JOIN {$wpdb->posts} p ON p.ID = tr.object_id WHERE p.ID IS NULL AND tt.taxonomy <> 'link_category'", 'term_relationships' ),
			'term_relationships_without_term' => $capped( "SELECT 1 FROM {$wpdb->term_relationships} tr LEFT JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id WHERE tt.term_taxonomy_id IS NULL", 'term_relationships_term' ),
			'usermeta_without_user'       => $capped( "SELECT 1 FROM {$wpdb->usermeta} um LEFT JOIN {$wpdb->users} u ON u.ID = um.user_id WHERE u.ID IS NULL", 'usermeta' ),
		);

		$suppress = $wpdb->suppress_errors( true );
		$revisions_by_type = array();
		foreach ( (array) $wpdb->get_results( "SELECT COALESCE(parent.post_type, '(no parent)') AS type, COUNT(*) AS c FROM {$wpdb->posts} r LEFT JOIN {$wpdb->posts} parent ON parent.ID = r.post_parent WHERE r.post_type = 'revision' GROUP BY parent.post_type ORDER BY c DESC LIMIT 50", ARRAY_A ) as $r ) { // phpcs:ignore WordPress.DB
			$revisions_by_type[ $r['type'] ] = (int) $r['c'];
		}
		$trash_by_type = array();
		foreach ( (array) $wpdb->get_results( "SELECT post_type, COUNT(*) AS c FROM {$wpdb->posts} WHERE post_status = 'trash' GROUP BY post_type ORDER BY c DESC LIMIT 50", ARRAY_A ) as $r ) { // phpcs:ignore WordPress.DB
			$trash_by_type[ $r['post_type'] ] = (int) $r['c'];
		}
		$comments = array();
		foreach ( (array) $wpdb->get_results( "SELECT comment_approved AS s, COUNT(*) AS c FROM {$wpdb->comments} WHERE comment_approved IN ('spam','trash') GROUP BY comment_approved", ARRAY_A ) as $r ) { // phpcs:ignore WordPress.DB
			$comments[ $r['s'] ] = (int) $r['c'];
		}
		$wpdb->suppress_errors( $suppress );

		$content = array(
			'revisions_total'    => array_sum( $revisions_by_type ),
			'revisions_by_type'  => (object) $revisions_by_type,
			'wp_post_revisions'  => defined( 'WP_POST_REVISIONS' ) ? WP_POST_REVISIONS : true,
			'auto_drafts'        => self::scalar( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status = 'auto-draft'", $errors, 'auto_drafts' ),
			'trashed_posts'      => array_sum( $trash_by_type ),
			'trashed_by_type'    => (object) $trash_by_type,
			'spam_comments'      => isset( $comments['spam'] ) ? $comments['spam'] : 0,
			'trashed_comments'   => isset( $comments['trash'] ) ? $comments['trash'] : 0,
			'empty_trash_days'   => EMPTY_TRASH_DAYS,
		);

		if ( $sqlite ) {
			$notes[] = 'SQLite database (SQLite Database Integration): table sizes, overhead, engines and collations are not available; row counts are exact COUNT(*).';
			$file    = defined( 'FQDB' ) ? FQDB : ( defined( 'DB_DIR' ) && defined( 'DB_FILE' ) ? DB_DIR . DB_FILE : '' );
			if ( $file && @file_exists( $file ) ) { // phpcs:ignore
				$total   = (int) @filesize( $file ); // phpcs:ignore
				$notes[] = 'total_bytes is the size of the SQLite database file.';
			}
		} else {
			$notes[] = 'rows is InnoDB\'s estimate from SHOW TABLE STATUS and can be off by 40%; overhead is Data_free (reclaimable with OPTIMIZE TABLE, which locks the table).';
		}
		$notes[] = 'Table owners are guessed from the name after the prefix against installed plugin slugs; "unknown" and "not_installed" are candidates for orphaned tables, not proof.';

		return array(
			'engine'            => $sqlite ? 'sqlite' : 'mysql',
			'server_version'    => $sqlite ? ( class_exists( 'SQLite3' ) ? SQLite3::version()['versionString'] : null ) : $wpdb->db_server_info(),
			'charset'           => $wpdb->charset,
			'collate'           => $wpdb->collate,
			'prefix'            => $prefix,
			'table_count'       => count( $tables ),
			'total_bytes'       => $total,
			'total_mb'          => round( $total / 1048576, 2 ),
			'overhead_bytes'    => $sqlite ? null : $overhead,
			'tables'            => array_slice( $tables, 0, 200 ),
			'possible_orphan_tables' => array_slice( $orphan_tables, 0, 100 ),
			'charset_issues'    => $charset,
			'orphaned_rows'     => $orphans,
			'content'           => $content,
			'errors'            => $errors ? $errors : null,
			'notes'             => $notes,
		);
	}

	/**
	 * Who owns a table.
	 *
	 * @param string $name Table.
	 * @param array  $core_tables Core table names with prefix.
	 * @param string $prefix Prefix.
	 * @return array { slug, status: core|active|inactive|not_installed|unknown|foreign_prefix, via }
	 */
	private function table_owner( $name, $core_tables, $prefix ) {
		global $wpdb;
		if ( in_array( $name, $core_tables, true ) ) {
			return array( 'slug' => 'wordpress', 'status' => 'core', 'via' => 'core table' );
		}
		$base = $wpdb->base_prefix;
		if ( 0 !== strpos( $name, $base ) ) {
			return array( 'slug' => null, 'status' => 'foreign_prefix', 'via' => 'table does not start with the site prefix "' . $prefix . '" — another install or app shares this database' );
		}
		$suffix = substr( $name, strlen( $prefix ) );
		if ( is_multisite() && preg_match( '/^' . preg_quote( $base, '/' ) . '(\d+)_(.*)$/', $name, $m ) ) {
			$suffix = $m[2];
		}
		$owner = self::guess_owner( $suffix );
		if ( $owner ) {
			return array( 'slug' => $owner['slug'], 'status' => $owner['status'], 'via' => $owner['via'] );
		}
		return array( 'slug' => null, 'status' => 'unknown', 'via' => 'no installed plugin or theme matches "' . strtok( $suffix, '_' ) . '"' );
	}
}
